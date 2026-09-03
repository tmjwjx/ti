/**
 * 一轮用户输入：问模型 → 有 toolCall 就执行并回灌 → 再问。
 * 没有工具调用或超过 MAX_TURNS 则结束。状态就是 messages。
 */
import type { Message, ToolCall } from "../types.ts";
import { getProvider } from "../config/index.ts";
import { callLLM } from "../llm/index.ts";
import { runTool, TOOLS } from "../tools/index.ts";

const MAX_TURNS = 100;

/** cli 注入。core 只发事件，不打印。 */
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
}

export async function agentTurn(messages: Message[], ctx: AgentContext): Promise<void> {
  const { ui } = ctx;
  for (let turn = 0; ; turn++) {
    if (turn >= MAX_TURNS) {
      ui.error(`\n[stopped: reached max ${MAX_TURNS} turns]`);
      return;
    }
    const msg = await callLLM(getProvider(), ctx.systemPrompt, messages, TOOLS, ui.text);
    messages.push(msg);
    const toolCalls = msg.content.filter((b): b is ToolCall => b.type === "toolCall");
    if (toolCalls.length === 0) break;

    for (const tc of toolCalls) {
      ui.toolCall(tc);
      let out: string, isError = false;
      // 截断时工具参数可能是半截 JSON，不执行
      if (msg.stopReason === "length") {
        out = "Error: response hit the output token limit, so tool call arguments may be truncated. Re-issue the tool call with complete arguments.";
        isError = true;
      } else {
        try {
          out = await runTool(tc.name, tc.arguments);
        } catch (e) {
          out = `Error: ${e instanceof Error ? e.message : String(e)}`;
          isError = true;
        }
      }
      ui.result(out, isError);
      messages.push({ role: "toolResult", toolCallId: tc.id, toolName: tc.name, content: out, isError });
    }
    ui.info(`  · tokens: ${msg.usage.input} in / ${msg.usage.output} out`);
  }
}
