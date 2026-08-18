/**
 * Anthropic Messages API（stream:true）。
 * 收发边界负责「自定义内部格式 ↔ Anthropic 线格式」的双向翻译：
 * - 发出：ToolCall → tool_use（arguments→input）；连续 toolResult 消息归并为
 *   一条 user 消息里的 tool_result 块（Anthropic 要求工具结果挂在 user 角色下）
 * - 收回：content_block 事件流 → TextContent/ToolCall（tool_use 参数以
 *   input_json_delta 分片下发，按块下标累积后一次性 JSON.parse）；
 *   stop_reason 归一化（max_tokens→length 等）
 * - onText 回调把文本增量实时打到终端（流式体验的核心）
 *
 * 无状态：provider、系统提示词与工具 schema 全部由调用方传入。
 */
import type { AssistantMessage, Message, ProviderConf, StopReason, TextContent, ToolCall } from "../types.ts";
import { sseJson } from "./sse.ts";

/** 内部消息 → Anthropic 线格式。连续 toolResult 归并进一条 user 消息（role 交替约束） */
function toWire(messages: Message[]): any[] {
  const out: any[] = [];
  let results: any[] = [];
  const flush = () => {
    if (results.length) {
      out.push({ role: "user", content: results });
      results = [];
    }
  };
  for (const m of messages) {
    if (m.role === "toolResult") {
      results.push({ type: "tool_result", tool_use_id: m.toolCallId, content: m.content, is_error: m.isError });
    } else if (m.role === "user") {
      flush();
      out.push({ role: "user", content: m.content }); // string 与 TextContent[] 两种 Anthropic 都收
    } else {
      flush();
      out.push({
        role: "assistant",
        content: m.content.map((b) => (b.type === "text" ? b : { type: "tool_use", id: b.id, name: b.name, input: b.arguments })),
      });
    }
  }
  flush();
  return out;
}

/** Anthropic stop_reason 方言 → 归一化 StopReason */
function mapStop(reason: string | undefined, prev: StopReason): StopReason {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    default:
      return prev; // 未知值保持现状（安全兜底）
  }
}

export async function callAnthropic(
  provider: ProviderConf,
  systemPrompt: string,
  messages: Message[],
  tools: any[],
  onText: (delta: string) => void,
): Promise<AssistantMessage> {
  const res = await fetch(`${provider.baseURL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(provider.auth === "bearer" ? { authorization: `Bearer ${provider.apiKey}` } : { "x-api-key": provider.apiKey! }),
    },
    body: JSON.stringify({ model: provider.model, max_tokens: 16384, stream: true, system: systemPrompt, messages: toWire(messages), tools }),
  });
  if (!res.ok || !res.body) throw new Error(`API error ${res.status}: ${await res.text()}`);

  // content 按 content_block 的 index 存放；端点若返回 thinking 等未处理块会留下空洞，
  // 最后统一 filter(Boolean) 丢弃（本 agent 不开启 thinking，丢弃是安全兜底）
  const content: (TextContent | ToolCall)[] = [];
  const jsonBuf: string[] = []; // 按块下标累积 tool_use 参数的 partial_json 分片
  let stopReason: StopReason = "stop";
  const usage = { input: 0, output: 0 };

  for await (const ev of sseJson(res)) {
    switch (ev.type) {
      case "message_start": // 消息开始：携带输入 token 数
        usage.input = ev.message?.usage?.input_tokens ?? 0;
        break;
      case "content_block_start": // 内容块开始：text 建空文本块；tool_use 建调用块并开始累积参数
        if (ev.content_block.type === "text") content[ev.index] = { type: "text", text: "" };
        else if (ev.content_block.type === "tool_use") {
          content[ev.index] = { type: "toolCall", id: ev.content_block.id, name: ev.content_block.name, arguments: {} };
          jsonBuf[ev.index] = "";
        }
        break;
      case "content_block_delta": // 增量：文本 → 追加并回调打印；工具参数 → 累积 JSON 分片
        if (ev.delta.type === "text_delta") {
          (content[ev.index] as TextContent).text += ev.delta.text;
          onText(ev.delta.text);
        } else if (ev.delta.type === "input_json_delta") jsonBuf[ev.index] += ev.delta.partial_json;
        break;
      case "content_block_stop": {
        // 块结束：把累积的工具参数 JSON 一次性解析（解析失败兜底为空对象）
        const b = content[ev.index];
        if (b?.type === "toolCall") {
          try {
            b.arguments = JSON.parse(jsonBuf[ev.index] || "{}");
          } catch {
            b.arguments = {};
          }
        }
        break;
      }
      case "message_delta": // 收尾：stop_reason 与输出 token 数
        stopReason = mapStop(ev.delta?.stop_reason, stopReason);
        usage.output = ev.usage?.output_tokens ?? usage.output;
        break;
      case "error":
        throw new Error(`API stream error: ${ev.error?.message ?? JSON.stringify(ev)}`);
    }
  }
  return { role: "assistant", content: content.filter(Boolean), stopReason, usage };
}
