// Anthropic Messages API（stream）
// 发出：连续 toolResult 归并成 user；相邻 user 合成一条
// 收回：按 content_block 下标累积，stop_reason 收成 StopReason
import type { AssistantMessage, LlmMessage, ProviderConf, StopReason, TextContent, ToolCall } from "../types.ts";
import { sseJson } from "./sse.ts";

// 线上 user 内容收成块数组
function asUserBlocks(content: any): any[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

// 两段 user 内容合成一段
function mergeUserContent(a: any, b: any): any {
  if (typeof a === "string" && typeof b === "string") return a + "\n\n" + b;
  return [...asUserBlocks(a), ...asUserBlocks(b)];
}

// 把一条 user 接到线上消息末尾，相邻的合成一条以免角色不能交替
function pushUser(out: any[], content: any): void {
  const last = out[out.length - 1];
  if (last?.role === "user") {
    last.content = mergeUserContent(last.content, content);
    return;
  }
  out.push({ role: "user", content });
}

// 内部消息收成 Anthropic 线格式
function toWire(messages: LlmMessage[]): any[] {
  const out: any[] = [];
  let results: any[] = [];
  const flushResults = () => {
    if (results.length) {
      pushUser(out, results);
      results = [];
    }
  };
  for (const m of messages) {
    if (m.role === "toolResult") {
      results.push({ type: "tool_result", tool_use_id: m.toolCallId, content: m.content, is_error: m.isError });
    } else if (m.role === "user") {
      flushResults();
      pushUser(out, m.content);
    } else {
      flushResults();
      out.push({
        role: "assistant",
        content: m.content.map((b) => (b.type === "text" ? b : { type: "tool_use", id: b.id, name: b.name, input: b.arguments })),
      });
    }
  }
  flushResults();
  return out;
}

// 线上 stop_reason 收成内部 StopReason。空的保持原值，避免把已有结束冲掉
function mapStop(reason: string | undefined, prev: StopReason | undefined): StopReason | undefined {
  if (!reason) return prev;
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "toolUse";
  return "stop";
}

// 流碎片收成内部 assistant 消息
function toInternalAssistant(
  content: (TextContent | ToolCall)[],
  jsonBuf: string[],
  hasStartInput: boolean[],
  stopReason: StopReason | undefined,
  usage: { input: number; output: number },
): AssistantMessage {
  let argsOk = true;
  for (let i = 0; i < content.length; i++) {
    const b = content[i];
    if (b?.type !== "toolCall") continue;
    const raw = jsonBuf[i];
    if (raw) {
      try {
        b.arguments = JSON.parse(raw);
      } catch {
        argsOk = false;
      }
    } else if (!hasStartInput[i]) {
      // 开场没带 input，后面也没 json 碎片：不能当成合法空对象去跑
      argsOk = false;
    }
  }
  // 没收到线上结束原因就不是说完；说完或要调工具但 JSON 解不开也不能跑
  if (stopReason === undefined) stopReason = "incomplete";
  else if ((stopReason === "toolUse" || stopReason === "stop") && !argsOk) stopReason = "badArgs";
  return { role: "assistant", content: content.filter(Boolean), stopReason, usage };
}

// 走 Anthropic 流式接口
export async function callAnthropic(
  provider: ProviderConf,
  systemPrompt: string,
  messages: LlmMessage[],
  tools: any[],
  onText: (delta: string) => void,
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  // 按下标放块；未处理的类型会留下空洞，最后 filter(Boolean) 丢掉
  const content: (TextContent | ToolCall)[] = [];
  const jsonBuf: string[] = [];
  const hasStartInput: boolean[] = [];
  let stopReason: StopReason | undefined;
  const usage = { input: 0, output: 0 };
  try {
    const res = await fetch(`${provider.baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        // provider.auth 是 bearer 走 Authorization，否则 x-api-key
        ...(provider.auth === "bearer" ? { authorization: `Bearer ${provider.apiKey}` } : { "x-api-key": provider.apiKey! }),
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 16384,
        stream: true,
        system: systemPrompt,
        messages: toWire(messages),
        ...(tools.length ? { tools } : {}),
      }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`API error ${res.status}: ${await res.text()}`);

    for await (const ev of sseJson(res)) {
      switch (ev.type) {
      case "message_start": {
        // input_tokens 不含缓存。Kimi 命中缓存时它只剩一小截，自动压缩会永远不触发
        const u = ev.message?.usage ?? {};
        usage.input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        break;
      }
      case "content_block_start":
        if (ev.content_block.type === "text") content[ev.index] = { type: "text", text: "" };
        else if (ev.content_block.type === "tool_use") {
          // 有的端点在 start 就带完整 input，后面没有 json delta
          const start = ev.content_block.input;
          content[ev.index] = { type: "toolCall", id: ev.content_block.id, name: ev.content_block.name, arguments: start ?? {} };
          jsonBuf[ev.index] = "";
          hasStartInput[ev.index] = start !== undefined && start !== null;
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
      case "message_delta":
        stopReason = mapStop(ev.delta?.stop_reason, stopReason);
        usage.output = ev.usage?.output_tokens ?? usage.output;
        break;
      case "error":
        throw new Error(`API stream error: ${ev.error?.message ?? JSON.stringify(ev)}`);
      }
    }
    return toInternalAssistant(content, jsonBuf, hasStartInput, stopReason, usage);
  } catch (e) {
    // 同 openai：有半截就返回，空的再抛 AbortError
    if (e instanceof Error && e.name === "AbortError") {
      if (content.filter(Boolean).length) return toInternalAssistant(content, jsonBuf, hasStartInput, stopReason, usage);
    }
    throw e;
  }
}
