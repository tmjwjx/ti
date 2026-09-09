// 一轮用户输入：问模型 → 有 toolCall 就执行并回灌 → 再问
// 没有工具调用或超过 MAX_TURNS 则结束。状态就是 messages
import type { Message, TextContent, ToolCall } from "../types.ts";
import { getProvider } from "../config/index.ts";
import { callLLM, isAbortError } from "../llm/index.ts";
import { runTool, TOOLS } from "../tools/index.ts";

const MAX_TURNS = 100;

// cli 注入。core 只发事件，不打印
export interface AgentUI {
  text(delta: string): void;
  toolCall(tc: ToolCall): void;
  result(out: string, isError: boolean): void;
  info(s: string): void;
  error(s: string): void;
}

export interface AgentContext {
  systemPrompt: string;
  ui: AgentUI;
  signal?: AbortSignal;
}

// 打断时补上缺失的 toolResult
function sealTools(msg: { content: (TextContent | ToolCall)[] }, ui: AgentUI, messages: Message[], reason: string) {
  // 每个 toolCall 必须有对应结果，否则下一轮协议 400
  const toolCalls = msg.content.filter((b): b is ToolCall => b.type === "toolCall");
  for (const tc of toolCalls) {
    ui.result(reason, true);
    messages.push({ role: "toolResult", toolCallId: tc.id, toolName: tc.name, content: reason, isError: true });
  }
}

// 处理一轮用户输入
export async function agentTurn(messages: Message[], ctx: AgentContext): Promise<void> {
  const { ui, signal } = ctx;
  for (let turn = 0; ; turn++) {
    if (signal?.aborted) {
      ui.info("[interrupted]");
      return;
    }
    if (turn >= MAX_TURNS) {
      ui.error(`\n[stopped: reached max ${MAX_TURNS} turns]`);
      return;
    }
    let msg;
    try {
      msg = await callLLM(getProvider(), ctx.systemPrompt, messages, TOOLS, ui.text, signal);
    } catch (e) {
      // 流还没攒出 assistant 就 abort：这里返回。REPL 不会 pop user
      if (isAbortError(e)) {
        ui.info("[interrupted]");
        return;
      }
      throw e;
    }
    messages.push(msg);
    const tokenLine =
      msg.usage.input || msg.usage.output
        ? `  ${msg.usage.input.toLocaleString("en-US")} in · ${msg.usage.output.toLocaleString("en-US")} out`
        : "";
    // usage 全 0（流被掐断常见）就不打，避免刷 0 in · 0 out
    const noteTokens = () => {
      if (tokenLine) ui.info(tokenLine);
    };
    const toolCalls = msg.content.filter((b): b is ToolCall => b.type === "toolCall");
    if (signal?.aborted) {
      if (toolCalls.length) sealTools(msg, ui, messages, "Error: aborted by user");
      noteTokens();
      ui.info("[interrupted]");
      return;
    }
    if (toolCalls.length === 0) {
      noteTokens();
      break;
    }

    for (const tc of toolCalls) {
      ui.toolCall(tc);
      let out: string, isError = false;
      // 截断时工具参数可能是半截 JSON，不执行
      if (msg.stopReason === "length") {
        out = "Error: response hit the output token limit, so tool call arguments may be truncated. Re-issue the tool call with complete arguments.";
        isError = true;
      } else if (signal?.aborted) {
        out = "Error: aborted by user";
        isError = true;
      } else {
        try {
          out = await runTool(tc.name, tc.arguments, signal);
        } catch (e) {
          out = `Error: ${e instanceof Error ? e.message : String(e)}`;
          isError = true;
        }
      }
      ui.result(out, isError);
      messages.push({ role: "toolResult", toolCallId: tc.id, toolName: tc.name, content: out, isError });
    }
    noteTokens();
    if (signal?.aborted) {
      ui.info("[interrupted]");
      return;
    }
  }
}
