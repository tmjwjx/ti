// 按协议转到对应厂家。内部消息先翻成协议认得的三种，再分发
import { dirname } from "node:path";
import type {
  AssistantMessage,
  LlmMessage,
  Message,
  ProviderConf,
  SkillMessage,
  SummaryMessage,
  TextContent,
  UserMessage,
} from "../types.ts";
import { callAnthropic } from "./anthropic.ts";
import { callOpenAI } from "./openai.ts";

// 摘要发给模型时的前后缀。照 pi，正文存在 summary 里，这句话只在这里出现
const SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
const SUMMARY_SUFFIX = `
</summary>`;

// 是不是取消请求抛出的错
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

// 各家超限措辞不一样，认不出就当普通错误
const OVERFLOW_MARKERS = ["context length", "maximum context", "too many tokens", "prompt is too long"];

// 是不是上下文超限。两个协议失败都是 `API error 400: ...`
export function isContextOverflowError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (!/API error 400\b/.test(e.message)) return false;
  const lower = e.message.toLowerCase();
  return OVERFLOW_MARKERS.some((k) => lower.includes(k));
}

// 文件清单贴在摘要后面。哪组为空就省掉，两组都空就什么都不加
function fileTags(files: SummaryMessage["files"]): string {
  const parts: string[] = [];
  if (files.read.length) parts.push(`<read-files>\n${files.read.join("\n")}\n</read-files>`);
  if (files.modified.length) parts.push(`<modified-files>\n${files.modified.join("\n")}\n</modified-files>`);
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}

function summaryToUser(m: SummaryMessage): UserMessage {
  return { role: "user", content: SUMMARY_PREFIX + m.text + fileTags(m.files) + SUMMARY_SUFFIX };
}

// 照 pi 的 /skill 展开：全文包在 <skill> 里，参数另起一段
function skillToUser(m: SkillMessage): UserMessage {
  const block = `<skill name="${m.name}" location="${m.path}">\nReferences are relative to ${dirname(m.path)}.\n\n${m.body}\n</skill>`;
  return { role: "user", content: m.args ? `${block}\n\n${m.args}` : block };
}

function asBlocks(content: string | TextContent[]): TextContent[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

// 两条 user 并成一条。跳过 aborted、翻过 summary 之后很容易挨在一起
function mergeUser(a: UserMessage, b: UserMessage): UserMessage {
  if (typeof a.content === "string" && typeof b.content === "string") {
    return { role: "user", content: `${a.content}\n\n${b.content}` };
  }
  return { role: "user", content: [...asBlocks(a.content), ...asBlocks(b.content)] };
}

// 内部消息翻成协议认得的三种。aborted 整条丢掉，summary、skill 变成 user
export function toLlm(messages: Message[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.stopReason === "aborted") continue;
    const next: LlmMessage = m.role === "summary" ? summaryToUser(m) : m.role === "skill" ? skillToUser(m) : m;
    const prev = out[out.length - 1];
    if (next.role === "user" && prev?.role === "user") {
      out[out.length - 1] = mergeUser(prev, next);
      continue;
    }
    out.push(next);
  }
  return out;
}

// 按协议转到对应厂家
export function callLLM(
  provider: ProviderConf,
  systemPrompt: string,
  messages: Message[],
  tools: any[],
  onText: (delta: string) => void,
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  const llmMessages = toLlm(messages);
  return provider.protocol === "anthropic"
    ? callAnthropic(provider, systemPrompt, llmMessages, tools, onText, signal)
    : callOpenAI(provider, systemPrompt, llmMessages, tools, onText, signal);
}
