/**
 * OpenAI chat/completions 兼容协议（stream）。
 * 发出：system 单独一条；toolResult 1:1 成 role:"tool"。
 * 收回：tool_calls 按 index 拼 arguments，finish_reason 收成 StopReason。
 */
import type { AssistantMessage, Message, ProviderConf, StopReason, TextContent, ToolCall } from "../types.ts";
import { sseJson } from "./sse.ts";

function toWire(systemPrompt: string, messages: Message[]): any[] {
  const oaiMessages: any[] = [{ role: "system", content: systemPrompt }];
  for (const m of messages) {
    if (m.role === "user") {
      oaiMessages.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      // 线上文本和 tool_calls 是两个字段，块的混排顺序到这里会丢
      const text = m.content.filter((b): b is TextContent => b.type === "text").map((b) => b.text).join("");
      const toolCalls = m.content.filter((b): b is ToolCall => b.type === "toolCall").map((tc) => ({
        id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
      }));
      oaiMessages.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else {
      oaiMessages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return oaiMessages;
}

export async function callOpenAI(
  provider: ProviderConf,
  systemPrompt: string,
  messages: Message[],
  tools: any[],
  onText: (delta: string) => void,
): Promise<AssistantMessage> {
  const res = await fetch(`${provider.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 8192,
      stream: true,
      stream_options: { include_usage: true },
      messages: toWire(systemPrompt, messages),
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`API error ${res.status}: ${await res.text()}`);

  let text = "";
  const calls: Record<number, { id: string; name: string; args: string }> = {};
  let stopReason: StopReason = "stop";
  const usage = { input: 0, output: 0 };
  for await (const ev of sseJson(res)) {
    if (ev.usage) {
      usage.input = ev.usage.prompt_tokens ?? usage.input;
      usage.output = ev.usage.completion_tokens ?? usage.output;
    }
    const choice = ev.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      onText(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const c = (calls[tc.index] ??= { id: "", name: "", args: "" });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name = tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
    }
    if (choice.finish_reason === "length") stopReason = "length";
    else if (choice.finish_reason === "tool_calls") stopReason = "toolUse";
    else if (choice.finish_reason) stopReason = "stop";
  }

  const content: (TextContent | ToolCall)[] = [];
  if (text) content.push({ type: "text", text });
  for (const c of Object.values(calls)) {
    let args: Record<string, any> = {};
    try {
      args = JSON.parse(c.args || "{}");
    } catch {
      args = {};
    }
    content.push({ type: "toolCall", id: c.id, name: c.name, arguments: args });
  }
  return { role: "assistant", content, stopReason, usage };
}
