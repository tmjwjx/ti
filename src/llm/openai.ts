/**
 * OpenAI chat/completions 兼容协议（DeepSeek 官方 API 等）。
 * 在收发边界做格式转换，内部仍是统一的 Block[]：
 * - 发出：system 提示词 → 首条 system 消息；assistant 的 tool_use → tool_calls 数组
 *   （arguments 是 JSON 字符串）；每个 tool_result → 一条独立的 role:"tool" 消息
 * - 收回：delta.content 是文本增量；delta.tool_calls 按 index 累积
 *   （id/name 只出现在首个分片，arguments 逐片拼接）；
 *   finish_reason "length" 映射为 max_tokens，复用 agentTurn 的截断保护
 *
 * 无状态：provider、系统提示词与工具 schema 全部由调用方传入。
 */
import type { Block, LlmResult, Message, ProviderConf, TextBlock, ToolUse } from "../types.ts";
import { sseJson } from "./sse.ts";

export async function callOpenAI(
  provider: ProviderConf,
  systemPrompt: string,
  messages: Message[],
  tools: any[],
  onText: (delta: string) => void,
): Promise<LlmResult> {
  // ---- 1) 消息转换：内部 Block[] → OpenAI chat 格式
  const oaiMessages: any[] = [{ role: "system", content: systemPrompt }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      oaiMessages.push({ role: m.role, content: m.content });
    } else if (m.role === "assistant") {
      const text = m.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("");
      const toolCalls = m.content.filter((b): b is ToolUse => b.type === "tool_use").map((tu) => ({
        id: tu.id, type: "function", function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
      }));
      oaiMessages.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else {
      // user 角色此时只会是 tool_result 块数组：每个结果一条独立的 tool 消息
      for (const tr of m.content)
        if (tr.type === "tool_result") oaiMessages.push({ role: "tool", tool_call_id: tr.tool_use_id, content: tr.content });
    }
  }
  const res = await fetch(`${provider.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 8192,
      stream: true,
      stream_options: { include_usage: true }, // 让最后一个分片携带 token 用量
      messages: oaiMessages,
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`API error ${res.status}: ${await res.text()}`);

  // ---- 2) 流式累积
  let text = "";
  const calls: Record<number, { id: string; name: string; args: string }> = {};
  let stopReason = "end_turn";
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
    if (choice.finish_reason) stopReason = choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason;
  }

  // ---- 3) 组装回内部 Block[]（text 在前，tool_use 按 index 顺序）
  const content: Block[] = [];
  if (text) content.push({ type: "text", text });
  for (const c of Object.values(calls)) {
    let input: any = {};
    try {
      input = JSON.parse(c.args || "{}");
    } catch {
      /* 参数 JSON 不完整时兜底为空对象 */
    }
    content.push({ type: "tool_use", id: c.id, name: c.name, input });
  }
  return { content, stopReason, usage };
}
