// 按协议转到对应厂家
import type { AssistantMessage, Message, ProviderConf } from "../types.ts";
import { callAnthropic } from "./anthropic.ts";
import { callOpenAI } from "./openai.ts";

// 是不是取消请求抛出的错
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
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
