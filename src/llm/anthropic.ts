// Anthropic Messages API（stream）。
// 发出：连续 toolResult 归并成一条 user（协议要求结果挂在 user 下）。
// 收回：按 content_block 下标累积，stop_reason 收成 StopReason。
import type { AssistantMessage, Message, ProviderConf, StopReason, TextContent, ToolCall } from "../types.ts";
import { sseJson } from "./sse.ts";

// 内部 Message → Anthropic 线格式。连续 toolResult 必须并进同一条 user。
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
      out.push({ role: "user", content: m.content });
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

// 线上 stop_reason → 内部 StopReason。未知值沿用上一次，避免空 delta 把状态冲掉。
function mapStop(reason: string | undefined, prev: StopReason): StopReason {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    default:
      return prev;
  }
}

// 流里按下标攒的块 → 内部 AssistantMessage。空洞下标丢掉。不是线上格式。
function toInternalAssistant(
  content: (TextContent | ToolCall)[],
  stopReason: StopReason,
  usage: { input: number; output: number },
): AssistantMessage {
  return { role: "assistant", content: content.filter(Boolean), stopReason, usage };
}

// 流式 messages 接口。signal 与半截返回语义同 callOpenAI。
export async function callAnthropic(
  provider: ProviderConf,
  systemPrompt: string,
  messages: Message[],
  tools: any[],
  onText: (delta: string) => void,
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  // 按下标放块；未处理的类型会留下空洞，最后 filter(Boolean) 丢掉
  const content: (TextContent | ToolCall)[] = [];
  const jsonBuf: string[] = [];
  let stopReason: StopReason = "stop";
  const usage = { input: 0, output: 0 };
  try {
    const res = await fetch(`${provider.baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        // Kimi 目录写 bearer；官方 Anthropic 才是 x-api-key。
        ...(provider.auth === "bearer" ? { authorization: `Bearer ${provider.apiKey}` } : { "x-api-key": provider.apiKey! }),
      },
      body: JSON.stringify({ model: provider.model, max_tokens: 16384, stream: true, system: systemPrompt, messages: toWire(messages), tools }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`API error ${res.status}: ${await res.text()}`);

    for await (const ev of sseJson(res)) {
      switch (ev.type) {
      case "message_start":
        usage.input = ev.message?.usage?.input_tokens ?? 0;
        break;
      case "content_block_start":
        if (ev.content_block.type === "text") content[ev.index] = { type: "text", text: "" };
        else if (ev.content_block.type === "tool_use") {
          // 有的端点在 start 就带完整 input，后面没有 json delta
          content[ev.index] = { type: "toolCall", id: ev.content_block.id, name: ev.content_block.name, arguments: ev.content_block.input ?? {} };
          jsonBuf[ev.index] = "";
        }
        break;
      case "content_block_delta":
        if (ev.delta.type === "text_delta") {
          const b = content[ev.index];
          if (b?.type === "text") {
            b.text += ev.delta.text;
            onText(ev.delta.text);
          }
        } else if (ev.delta.type === "input_json_delta" && jsonBuf[ev.index] !== undefined) {
          jsonBuf[ev.index] += ev.delta.partial_json;
        }
        break;
      case "content_block_stop": {
        const b = content[ev.index];
        if (b?.type === "toolCall" && jsonBuf[ev.index]) {
          try {
            b.arguments = JSON.parse(jsonBuf[ev.index]);
          } catch {
            b.arguments = {};
          }
        }
        break;
      }
      case "message_delta":
        stopReason = mapStop(ev.delta?.stop_reason, stopReason);
        usage.output = ev.usage?.output_tokens ?? usage.output;
        break;
      case "error":
        throw new Error(`API stream error: ${ev.error?.message ?? JSON.stringify(ev)}`);
      }
    }
    return toInternalAssistant(content, stopReason, usage);
  } catch (e) {
    // 同 openai：有半截就返回，空的再抛 AbortError。
    if (e instanceof Error && e.name === "AbortError") {
      if (content.filter(Boolean).length) return toInternalAssistant(content, stopReason, usage);
    }
    throw e;
  }
}
