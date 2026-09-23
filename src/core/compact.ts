// 上下文压缩：估算、切点、向模型要摘要、换掉内存并落盘
// 三个入口（手动 /compact、发请求前自动、超限兜底）都走 runCompact
// 摘要是 summary 角色，只存正文和文件清单。发给模型的前后缀在 llm/index.ts
import type { AssistantMessage, Message, SummaryMessage, TextContent, ToolCall } from "../types.ts";
import { getProvider } from "../config/index.ts";
import { callLLM, isAbortError } from "../llm/index.ts";
import { commitCompact, sessionFile } from "./session.ts";

const KEEP_FLOOR = 20_000;
const KEEP_CAP = 40_000;
const TRIGGER_CAP = 200_000;
const TOOL_RESULT_CHARS = 2_000;

// 压缩请求的提示词照 pi。中文对话压出来多半是英文，这是已知取舍
const SYSTEM = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const FIRST_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export type CompactResult =
  | { ok: true; before: number; after: number; carried: { input: number; output: number } }
  | { ok: false; aborted: boolean; empty: boolean; error: string };

const EMPTY_FILES: SummaryMessage["files"] = { read: [], modified: [] };

// 这个下标之前的 assistant.usage 不可信：要么是压缩前的上下文大小，要么是上个进程留下的
// 不标的话，压缩或恢复之后第一句话就会因为旧数字再压一次
let trustFrom = 0;

// 压缩、恢复之后调：当前这些消息的 usage 都不算
export function distrustUsage(messages: Message[]): void {
  trustFrom = messages.length;
}

// /clear 之后调
export function resetTrust(): void {
  trustFrom = 0;
}

// 窗口已知时的触发线。没有窗口就不自动压
export function triggerAt(window: number | undefined): number | undefined {
  if (!window) return undefined;
  return Math.min(Math.floor(window * 0.8), TRIGGER_CAP);
}

// 压缩后留下多少。没有窗口时手动压缩用固定下限
export function keepBudget(window: number | undefined): number {
  if (!window) return KEEP_FLOOR;
  return Math.max(KEEP_FLOOR, Math.min(Math.floor(window * 0.16), KEEP_CAP));
}

// CJK 一字一 token，其余四字一 token。纯 chars/4 会把中文低估约三倍
export function estimateText(s: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c > 0x2e7f) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

function textOf(content: string | TextContent[]): string {
  if (typeof content === "string") return content;
  return content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

// 一条消息大概多少 token。只用于切点，触发线用的是真实 usage
export function estimateTokens(msg: Message): number {
  if (msg.role === "summary") {
    return estimateText(msg.text) + estimateText(msg.files.read.join("\n")) + estimateText(msg.files.modified.join("\n"));
  }
  if (msg.role === "skill") return estimateText(msg.body) + estimateText(msg.args);
  if (msg.role === "user") return estimateText(textOf(msg.content));
  if (msg.role === "toolResult") return estimateText(msg.content);
  let n = 0;
  for (const b of msg.content) {
    if (b.type === "text") n += estimateText(b.text);
    else n += estimateText(b.name) + estimateText(JSON.stringify(b.arguments ?? {}));
  }
  return n;
}

// 全部按字数估。usage 不可信时兜底用
function estimateAll(messages: Message[]): number {
  let n = 0;
  for (const m of messages) n += estimateTokens(m);
  return n;
}

// 上一轮真实用量，加上那条 assistant 之后新写的内容（工具结果）。没有可信 usage 就是 0
export function contextTokens(messages: Message[]): number {
  for (let i = messages.length - 1; i >= Math.max(0, trustFrom); i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const used = m.usage.input + m.usage.output;
    if (!used) continue; // 被中断的 0/0 跳过
    let trailing = 0;
    for (let j = i + 1; j < messages.length; j++) trailing += estimateTokens(messages[j]!);
    return used + trailing;
  }
  return 0;
}

// 发请求前要不要先压。没有窗口或还没有用量就不压
export function shouldAutoCompact(messages: Message[], window: number | undefined): boolean {
  const line = triggerAt(window);
  if (line === undefined) return false;
  const used = contextTokens(messages);
  return used > line;
}

// 保留段从哪一条开始。没有可压的部分就 undefined
export function planCut(messages: Message[], keep: number): number | undefined {
  let acc = 0;
  let cut = 0;
  let hit = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateTokens(messages[i]!);
    if (acc >= keep) {
      cut = i;
      hit = true;
      break;
    }
  }
  if (!hit) return undefined;
  while (cut > 0 && messages[cut]?.role === "toolResult") cut -= 1;
  while (cut < messages.length && messages[cut]?.role === "toolResult") cut += 1;
  if (cut <= 0 || cut >= messages.length) return undefined;
  return cut;
}

// 工具结果只留开头。摘要不需要完整输出，截断标记写明丢了多少
function clipResult(s: string): string {
  if (s.length <= TOOL_RESULT_CHARS) return s;
  const dropped = s.length - TOOL_RESULT_CHARS;
  return `${s.slice(0, TOOL_RESULT_CHARS)}\n\n[... ${dropped} more characters truncated]`;
}

// 压成一段文本。不当成对话发，避免模型接着聊。summary 不进这里，单独放 previous-summary
function serialize(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = textOf(m.content);
      if (text) parts.push(`[User]: ${text}`);
    } else if (m.role === "skill") {
      parts.push(`[User]: /${m.name}${m.args ? ` ${m.args}` : ""}`);
      parts.push(`[Skill ${m.name}]: ${clipResult(m.body)}`);
    } else if (m.role === "toolResult") {
      if (m.content) parts.push(`[Tool result]: ${clipResult(m.content)}`);
    } else if (m.role === "assistant") {
      const calls: string[] = [];
      let text = "";
      for (const b of m.content) {
        if (b.type === "text") text += b.text;
        else {
          const args = Object.entries(b.arguments ?? {})
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(", ");
          calls.push(`${b.name}(${args})`);
        }
      }
      if (text) parts.push(`[Assistant]: ${text}`);
      if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
    }
  }
  return parts.join("\n\n");
}

function summaryText(msg: AssistantMessage): string | undefined {
  if (msg.stopReason !== "stop") return undefined;
  if (msg.content.some((b): b is ToolCall => b.type === "toolCall")) return undefined;
  const text = msg.content.filter((b): b is TextContent => b.type === "text").map((b) => b.text).join("").trim();
  return text || undefined;
}

// 读过、改过的文件。只算执行成功的调用，失败和被打断没跑的不算
function collectFiles(messages: Message[], prev: SummaryMessage["files"]): SummaryMessage["files"] {
  const ok = new Set<string>();
  for (const m of messages) {
    if (m.role === "toolResult" && !m.isError) ok.add(m.toolCallId);
  }
  const read = new Set(prev.read);
  const modified = new Set(prev.modified);
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.type !== "toolCall" || !ok.has(b.id)) continue;
      const path = typeof b.arguments?.path === "string" ? b.arguments.path : "";
      if (!path) continue;
      if (b.name === "read") read.add(path);
      else if (b.name === "write" || b.name === "edit") modified.add(path);
    }
  }
  for (const path of modified) read.delete(path);
  return { read: [...read].sort(), modified: [...modified].sort() };
}

// 压掉的 assistant 用量，加上这次摘要请求自己的用量，交给 /cost 结转
function carriedUsage(dropped: Message[], usage: { input: number; output: number }): { input: number; output: number } {
  let input = usage.input;
  let output = usage.output;
  for (const m of dropped) {
    if (m.role === "assistant") {
      input += m.usage.input;
      output += m.usage.output;
    }
  }
  return { input, output };
}

// 压一次。失败或被打断时内存和文件都保持原样
export async function runCompact(messages: Message[], signal?: AbortSignal): Promise<CompactResult> {
  const window = getProvider().contextWindow;
  const keep = keepBudget(window);
  const before = contextTokens(messages) || estimateAll(messages);
  const cut = planCut(messages, keep);
  if (cut === undefined) return { ok: false, aborted: false, empty: true, error: "nothing to compact" };
  const dropped = messages.slice(0, cut);
  const kept = messages.slice(cut);
  // 旧摘要在最前面。不进序列化，单独交给合并指令，文件清单和新的合并
  const previous = dropped[0]?.role === "summary" ? dropped[0] : undefined;
  const fresh = previous ? dropped.slice(1) : dropped;
  if (!fresh.length) return { ok: false, aborted: false, empty: true, error: "nothing to compact" };
  let body = `<conversation>\n${serialize(fresh)}\n</conversation>\n\n`;
  if (previous) body += `<previous-summary>\n${previous.text}\n</previous-summary>\n\n`;
  body += previous ? UPDATE_PROMPT : FIRST_PROMPT;
  let reply: AssistantMessage;
  try {
    reply = await callLLM(getProvider(), SYSTEM, [{ role: "user", content: body }], [], () => {}, signal);
  } catch (e) {
    if (signal?.aborted || isAbortError(e)) return { ok: false, aborted: true, empty: false, error: "aborted" };
    return { ok: false, aborted: false, empty: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (signal?.aborted) return { ok: false, aborted: true, empty: false, error: "aborted" };
  const text = summaryText(reply);
  if (!text) return { ok: false, aborted: false, empty: false, error: "summary was empty or incomplete" };
  const summary: SummaryMessage = {
    role: "summary",
    text,
    files: collectFiles(fresh, previous?.files ?? EMPTY_FILES),
  };
  const carried = carriedUsage(dropped, reply.usage);
  try {
    if (sessionFile()) commitCompact(summary, kept);
  } catch (e) {
    return { ok: false, aborted: false, empty: false, error: e instanceof Error ? e.message : String(e) };
  }
  messages.splice(0, messages.length, summary, ...kept);
  distrustUsage(messages);
  return { ok: true, before, after: estimateAll(messages), carried };
}
