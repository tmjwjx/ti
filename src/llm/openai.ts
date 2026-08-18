/**
 * OpenAI chat/completions 兼容协议（DeepSeek 官方 API 等）。
 * 收发边界负责「自定义内部格式 ↔ OpenAI 线格式」的双向翻译：
 * - 发出：system 提示词 → 首条 system 消息；assistant 的 ToolCall → tool_calls 数组
 *   （arguments 序列化成 JSON 字符串）；每条 toolResult 消息 1:1 → role:"tool" 消息
 * - 收回：delta.content 是文本增量；delta.tool_calls 按 index 累积
 *   （id/name 只出现在首个分片，arguments 逐片拼接后一次性 JSON.parse）；
 *   finish_reason 归一化（"length"→length、"tool_calls"→toolUse）
 *
 * 无状态：provider、系统提示词与工具 schema 全部由调用方传入。
 */
import type { AssistantMessage, Message, ProviderConf, StopReason, TextContent, ToolCall } from "../types.ts";
import { sseJson } from "./sse.ts";

/** 内部消息 → OpenAI chat 格式 */
function toWire(systemPrompt: string, messages: Message[]): any[] {
  const oaiMessages: any[] = [{ role: "system", content: systemPrompt }];
  for (const m of messages) {
    if (m.role === "user") {
      oaiMessages.push({ role: "user", content: m.content }); // string 直通；TextContent[] 与 OpenAI 的 text part 同形
    } else if (m.role === "assistant") {
      // OpenAI 线格式把文本与工具调用拆成两个字段（混排顺序在此丢失，这是该协议的固有局限）
      const text = m.content.filter((b): b is TextContent => b.type === "text").map((b) => b.text).join("");
      const toolCalls = m.content.filter((b): b is ToolCall => b.type === "toolCall").map((tc) => ({
        id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
      }));
      oaiMessages.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else {
      // toolResult 平铺消息与 role:"tool" 天然 1:1
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
      stream_options: { include_usage: true }, // 让最后一个分片携带 token 用量
      messages: toWire(systemPrompt, messages),
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`API error ${res.status}: ${await res.text()}`);

  // ---- 流式累积
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
    // finish_reason 方言 → 归一化 StopReason
    if (choice.finish_reason === "length") stopReason = "length";
    else if (choice.finish_reason === "tool_calls") stopReason = "toolUse";
    else if (choice.finish_reason) stopReason = "stop";
  }

  // ---- 组装回内部 AssistantMessage（text 在前，ToolCall 按 index 顺序）
  const content: (TextContent | ToolCall)[] = [];
  if (text) content.push({ type: "text", text });
  for (const c of Object.values(calls)) {
    let args: Record<string, any> = {};
    try {
      args = JSON.parse(c.args || "{}");
    } catch {
      /* 参数 JSON 不完整时兜底为空对象 */
    }
    content.push({ type: "toolCall", id: c.id, name: c.name, arguments: args });
  }
  return { role: "assistant", content, stopReason, usage };
}
