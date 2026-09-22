// 按协议转到对应厂家
import type { AssistantMessage, Message, ProviderConf } from "../types.ts";
import { callAnthropic } from "./anthropic.ts";
import { callOpenAI } from "./openai.ts";

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

// 按协议转到对应厂家
export function callLLM(
  provider: ProviderConf,
  systemPrompt: string,
  messages: Message[],
  tools: any[],
  onText: (delta: string) => void,
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  return provider.protocol === "anthropic"
    ? callAnthropic(provider, systemPrompt, messages, tools, onText, signal)
    : callOpenAI(provider, systemPrompt, messages, tools, onText, signal);
}
