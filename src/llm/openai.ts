// OpenAI chat/completions 兼容协议（stream）。
// 发出：system 单独一条；toolResult 1:1 成 role:"tool"。
// 收回：tool_calls 按 index 拼 arguments，finish_reason 收成 StopReason。
import type { AssistantMessage, Message, ProviderConf, StopReason, TextContent, ToolCall } from "../types.ts";
import { sseJson } from "./sse.ts";

// 内部 Message → OpenAI 线格式。assistant 的文本和 tool_calls 被拆成两个字段。
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
      // 只有 tool_calls 时 content 必须是 null，空字符串有的端点会拒。
      oaiMessages.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else {
      oaiMessages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return oaiMessages;
}

// 流里攒的碎片 → 内部 AssistantMessage。不是线上格式（线上是 toWire 的反方向）。
function toInternalAssistant(
  text: string,
  calls: Record<number, { id: string; name: string; args: string }>,
  stopReason: StopReason,
  usage: { input: number; output: number },
): AssistantMessage {
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

// 流式 chat/completions。signal 取消时：有半截就返回，空的抛 AbortError。
export async function callOpenAI(
  provider: ProviderConf,
  systemPrompt: string,
  messages: Message[],
  tools: any[],
  onText: (delta: string) => void,
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  let text = "";
  const calls: Record<number, { id: string; name: string; args: string }> = {};
  let stopReason: StopReason = "stop";
  const usage = { input: 0, output: 0 };
  try {
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
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`API error ${res.status}: ${await res.text()}`);

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
        // 同一 index 的碎片拼 arguments；??= 只在第一次见到这个下标时建槽。
        const c = (calls[tc.index] ??= { id: "", name: "", args: "" });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name = tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
      if (choice.finish_reason === "length") stopReason = "length";
      else if (choice.finish_reason === "tool_calls") stopReason = "toolUse";
      else if (choice.finish_reason) stopReason = "stop";
    }
    return toInternalAssistant(text, calls, stopReason, usage);
  } catch (e) {
    // 有半截就当正常返回，让历史能接；完全没数据再抛，agent 只打 [interrupted]。
    if (e instanceof Error && e.name === "AbortError") {
      if (text || Object.keys(calls).length) return toInternalAssistant(text, calls, stopReason, usage);
    }
    throw e;
  }
}
