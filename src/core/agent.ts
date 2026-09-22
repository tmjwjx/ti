// 一轮用户输入：问模型 → 有完整 toolCall 就执行并回灌 → 再问
// 说完、流失败或超过 MAX_TURNS 则结束。状态就是 messages，进出走 pushMessage
import type { Message, StopReason, ToolCall } from "../types.ts";
import { getProvider } from "../config/index.ts";
import { callLLM, isAbortError } from "../llm/index.ts";
import { runTool, TOOLS } from "../tools/index.ts";
import { pushMessage } from "./session.ts";

const MAX_TURNS = 100;
// 连续「有调用但不执行」只 seal 再 continue，到次数就停
const MAX_SEALED = 3;

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

// 给尚未有结果的 toolCall 补一条错误结果，避免下一轮协议 400
function sealTools(calls: ToolCall[], messages: Message[], reason: string) {
  for (const tc of calls) {
    pushMessage(messages, { role: "toolResult", toolCallId: tc.id, toolName: tc.name, content: reason, isError: true });
  }
}

// 从栈尾找回本轮还没配上结果的 toolCall
function unmatchedToolCalls(messages: Message[]): ToolCall[] {
  const done = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "toolResult") {
      done.add(m.toolCallId);
      continue;
    }
    if (m.role === "assistant") {
      return m.content.filter((b): b is ToolCall => b.type === "toolCall" && !done.has(b.id));
    }
    // 碰到 user：本轮还没有 assistant
    return [];
  }
  return [];
}

// 流没有正常结束时的英文原因
function streamFailReason(stop: StopReason): string | undefined {
  if (stop === "incomplete") return "Error: stream ended without finish_reason";
  if (stop === "badArgs") return "Error: tool call arguments were incomplete or invalid JSON";
}

// 明确要调工具，或正常说完且消息里已有完整 toolCall，才执行
function shouldRunTools(stop: StopReason, calls: ToolCall[]): boolean {
  if (calls.length === 0) return false;
  return stop === "toolUse" || stop === "stop";
}

// 用户中断后的一次收尾：按栈尾互斥补协议或写入说明，屏幕只打一次
function finishInterrupted(messages: Message[], ui: AgentUI): void {
  const open = unmatchedToolCalls(messages);
  if (open.length) {
    // 未配的 toolCall 必须先有结果，否则下一轮 400。协议已合法就不要再追加旁白
    const reason = "Error: aborted by user";
    for (let i = 0; i < open.length; i++) ui.result(reason, true);
    sealTools(open, messages, reason);
  } else {
    // 半截字或零字节：留下已有内容，用一条真 message 让下一轮不是没人答的提问
    pushMessage(messages, { role: "user", content: "[interrupted]" });
  }
  ui.info("[interrupted]");
}

// 处理一轮用户输入
export async function agentTurn(messages: Message[], ctx: AgentContext): Promise<void> {
  const { ui, signal } = ctx;
  let sealedTurns = 0;
  for (let turn = 0; ; turn++) {
    if (signal?.aborted) {
      finishInterrupted(messages, ui);
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
      // 零字节 abort：不 throw，由收尾写入说明。API 失败继续往外抛给 REPL
      if (isAbortError(e)) {
        finishInterrupted(messages, ui);
        return;
      }
      throw e;
    }
    const tokenLine =
      msg.usage.input || msg.usage.output
        ? `  ${msg.usage.input.toLocaleString("en-US")} in · ${msg.usage.output.toLocaleString("en-US")} out`
        : "";
    // usage 全 0（流被掐断常见）就不打，避免刷 0 in · 0 out
    const noteTokens = () => {
      if (tokenLine) ui.info(tokenLine);
    };
    const toolCalls = msg.content.filter((b): b is ToolCall => b.type === "toolCall");
    // 用户 abort 先收尾，不要和流失败合成
    if (signal?.aborted) {
      pushMessage(messages, msg);
      noteTokens();
      finishInterrupted(messages, ui);
      return;
    }
    const failReason = streamFailReason(msg.stopReason);
    if (failReason) {
      // 半截工具不跑，未配的补真实原因，然后停这一轮，不再问模型
      pushMessage(messages, msg);
      for (const tc of toolCalls) ui.toolCall(tc);
      sealTools(toolCalls, messages, failReason);
      noteTokens();
      ui.error(failReason);
      return;
    }
    // 流正常结束且无字无工具：不把空 assistant 写进历史
    if (
      msg.stopReason === "stop" &&
      toolCalls.length === 0 &&
      !msg.content.some((b) => b.type === "text" && b.text)
    ) {
      noteTokens();
      break;
    }
    pushMessage(messages, msg);
    if (toolCalls.length === 0) {
      noteTokens();
      break;
    }
    if (!shouldRunTools(msg.stopReason, toolCalls)) {
      // 有调用但不执行：截断时参数可能不完整，补错误再让模型重发
      const reason =
        "Error: response hit the output token limit, so tool call arguments may be truncated. Re-issue the tool call with complete arguments.";
      for (const tc of toolCalls) {
        ui.toolCall(tc);
        ui.result(reason, true);
      }
      sealTools(toolCalls, messages, reason);
      noteTokens();
      sealedTurns += 1;
      if (sealedTurns >= MAX_SEALED) {
        ui.error(`Error: stopped after ${MAX_SEALED} consecutive tool calls that were not executed`);
        return;
      }
      continue;
    }

    sealedTurns = 0;
    for (const tc of toolCalls) {
      if (signal?.aborted) break;
      ui.toolCall(tc);
      let out: string, isError = false;
      try {
        out = await runTool(tc.name, tc.arguments, signal);
      } catch (e) {
        out = `Error: ${e instanceof Error ? e.message : String(e)}`;
        isError = true;
      }
      ui.result(out, isError);
      pushMessage(messages, { role: "toolResult", toolCallId: tc.id, toolName: tc.name, content: out, isError });
    }
    noteTokens();
    if (signal?.aborted) {
      finishInterrupted(messages, ui);
      return;
    }
  }
}
