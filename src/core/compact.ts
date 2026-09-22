// 上下文压缩：估算、切点、向模型要摘要、换掉内存并落盘
// 三个入口（手动 /compact、发请求前自动、超限兜底）都走 runCompact
import type { AssistantMessage, Message, TextContent, ToolCall } from "../types.ts";
import { getProvider } from "../config/index.ts";
import { callLLM, isAbortError } from "../llm/index.ts";
import { commitCompact, sessionFile } from "./session.ts";

const KEEP_FLOOR = 20_000;
const KEEP_CAP = 40_000;
const TRIGGER_CAP = 200_000;
const TOOL_RESULT_CHARS = 2_000;
export const SUMMARY_OPEN = "<compacted-summary>";
export const SUMMARY_CLOSE = "</compacted-summary>";

const SYSTEM = "You are a compaction engine. Output only the structured summary. Do not call tools. Do not continue the conversation.";

const INSTRUCTION = `Output EXACTLY these sections, in order. If a section has nothing, write "(none)". Do not drop a section.

## Intent
## Technical Points
## Files and Changes
## Errors and Fixes
## Pending
## Current Work
## Next Step
## Constraints and Decisions

Preserve exact file paths, commands, error text, and function names.
If the conversation contains a ${SUMMARY_OPEN} block, merge it into this one summary. Drop facts that are no longer true. Do not output two summaries.`;

const PREAMBLE = "以下是此前对话的压缩记录，视为已知背景，直接继续，不要复述。";

export type CompactResult =
  | { ok: true; before: number; after: number; carried: { input: number; output: number } }
  | { ok: false; aborted: boolean; empty: boolean; error: string };

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

// 上一轮真实用量，加上那条 assistant 之后新写的内容（工具结果、中断说明）。没有可信 usage 就是 0
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

function clipResult(s: string): string {
  if (s.length <= TOOL_RESULT_CHARS) return s;
  return s.slice(0, TOOL_RESULT_CHARS) + "\n…";
}

// 压成一段文本。不当成对话发，避免模型接着聊
function serialize(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      parts.push(`[user]\n${textOf(m.content)}`);
    } else if (m.role === "toolResult") {
      parts.push(`[toolResult ${m.toolName}]\n${clipResult(m.content)}`);
    } else {
      const lines: string[] = [];
      for (const b of m.content) {
        if (b.type === "text" && b.text) lines.push(b.text);
        else if (b.type === "toolCall") lines.push(`tool ${b.name} ${JSON.stringify(b.arguments ?? {})}`);
      }
      parts.push(`[assistant]\n${lines.join("\n")}`);
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

function wrapSummary(text: string): Message {
  return { role: "user", content: `${PREAMBLE}\n\n${SUMMARY_OPEN}\n${text}\n${SUMMARY_CLOSE}` };
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
  let reply: AssistantMessage;
  try {
    reply = await callLLM(
      getProvider(),
      SYSTEM,
      [{ role: "user", content: `<conversation>\n${serialize(dropped)}\n</conversation>\n\n${INSTRUCTION}` }],
      [],
      () => {},
      signal,
    );
  } catch (e) {
    if (signal?.aborted || isAbortError(e)) return { ok: false, aborted: true, empty: false, error: "aborted" };
    return { ok: false, aborted: false, empty: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (signal?.aborted) return { ok: false, aborted: true, empty: false, error: "aborted" };
  const text = summaryText(reply);
  if (!text) return { ok: false, aborted: false, empty: false, error: "summary was empty or incomplete" };
  const summary = wrapSummary(text);
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
