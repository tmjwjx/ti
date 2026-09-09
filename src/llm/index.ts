// 按 protocol 分发。agent 只面对这一个函数。
import type { AssistantMessage, Message, ProviderConf } from "../types.ts";
import { callAnthropic } from "./anthropic.ts";
import { callOpenAI } from "./openai.ts";

// fetch 或流被 abort 时的标准错误名。agent 用来和真正的 API 错误分开。
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

// 按 protocol 分发。signal 原样传给 fetch，好让 Esc 取消请求。
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
