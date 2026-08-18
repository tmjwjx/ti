/**
 * LLM 协议分发：agent 循环只面对统一的 LlmResult，不关心底层是哪种协议。
 * 无状态模块：provider 与系统提示词由调用方显式传入。
 */
import type { LlmResult, Message, ProviderConf } from "../types.ts";
import { callAnthropic } from "./anthropic.ts";
import { callOpenAI } from "./openai.ts";

export function callLLM(
  provider: ProviderConf,
  systemPrompt: string,
  messages: Message[],
  tools: any[],
  onText: (delta: string) => void,
): Promise<LlmResult> {
  return provider.protocol === "anthropic"
    ? callAnthropic(provider, systemPrompt, messages, tools, onText)
    : callOpenAI(provider, systemPrompt, messages, tools, onText);
}
