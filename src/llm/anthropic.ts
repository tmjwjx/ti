/**
 * Anthropic Messages API（stream:true）。
 * - onText 回调把文本增量实时打到终端（流式体验的核心）
 * - tool_use 的参数以 input_json_delta 分片下发，按块下标累积后一次性 JSON.parse
 * - 返回：完整 assistant 内容块 + stop_reason + token 用量
 *
 * 无状态：provider、系统提示词与工具 schema 全部由调用方传入。
 */
import type { Block, LlmResult, Message, ProviderConf, TextBlock } from "../types.ts";
import { sseJson } from "./sse.ts";

export async function callAnthropic(
  provider: ProviderConf,
  systemPrompt: string,
  messages: Message[],
  tools: any[],
  onText: (delta: string) => void,
): Promise<LlmResult> {
  const res = await fetch(`${provider.baseURL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(provider.auth === "bearer" ? { authorization: `Bearer ${provider.apiKey}` } : { "x-api-key": provider.apiKey! }),
    },
    body: JSON.stringify({ model: provider.model, max_tokens: 16384, stream: true, system: systemPrompt, messages, tools }),
  });
  if (!res.ok || !res.body) throw new Error(`API error ${res.status}: ${await res.text()}`);

  // content 按 content_block 的 index 存放；端点若返回 thinking 等未处理块会留下空洞，
  // 最后统一 filter(Boolean) 丢弃（本 agent 不开启 thinking，丢弃是安全兜底）
  const content: Block[] = [];
  const jsonBuf: string[] = []; // 按块下标累积 tool_use 参数的 partial_json 分片
  let stopReason = "end_turn";
  const usage = { input: 0, output: 0 };

  for await (const ev of sseJson(res)) {
    switch (ev.type) {
      case "message_start": // 消息开始：携带输入 token 数
        usage.input = ev.message?.usage?.input_tokens ?? 0;
        break;
      case "content_block_start": // 内容块开始：text 建空文本块；tool_use 建调用块并开始累积参数
        if (ev.content_block.type === "text") content[ev.index] = { type: "text", text: "" };
        else if (ev.content_block.type === "tool_use") {
          content[ev.index] = { type: "tool_use", id: ev.content_block.id, name: ev.content_block.name, input: {} };
          jsonBuf[ev.index] = "";
        }
        break;
      case "content_block_delta": // 增量：文本 → 追加并回调打印；工具参数 → 累积 JSON 分片
        if (ev.delta.type === "text_delta") {
          (content[ev.index] as TextBlock).text += ev.delta.text;
          onText(ev.delta.text);
        } else if (ev.delta.type === "input_json_delta") jsonBuf[ev.index] += ev.delta.partial_json;
        break;
      case "content_block_stop": {
        // 块结束：把累积的工具参数 JSON 一次性解析（解析失败兜底为空对象）
        const b = content[ev.index];
        if (b?.type === "tool_use") {
          try {
            b.input = JSON.parse(jsonBuf[ev.index] || "{}");
          } catch {
            b.input = {};
          }
        }
        break;
      }
      case "message_delta": // 收尾：stop_reason（end_turn / tool_use / max_tokens）与输出 token 数
        stopReason = ev.delta?.stop_reason ?? stopReason;
        usage.output = ev.usage?.output_tokens ?? usage.output;
        break;
      case "error":
        throw new Error(`API stream error: ${ev.error?.message ?? JSON.stringify(ev)}`);
    }
  }
  return { content: content.filter(Boolean), stopReason, usage };
}
