/** 按 protocol 分发。agent 只面对这一个函数。 */
import type { AssistantMessage, Message, ProviderConf } from "../types.ts";
import { callAnthropic } from "./anthropic.ts";
import { callOpenAI } from "./openai.ts";

export function callLLM(
  provider: ProviderConf,
  systemPrompt: string,
  messages: Message[],
  tools: any[],
  onText: (delta: string) => void,
): Promise<AssistantMessage> {
  return provider.protocol === "anthropic"
    ? callAnthropic(provider, systemPrompt, messages, tools, onText)
    : callOpenAI(provider, systemPrompt, messages, tools, onText);
}
