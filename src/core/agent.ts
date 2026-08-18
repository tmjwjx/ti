/**
 * agent 主循环（对应 pi 的 agentLoop）：
 *   流式请求 LLM → 收集 tool_use → 顺序执行 → tool_result 回灌 → 再次请求 …
 * 直到响应里没有工具调用（end_turn）或触发 MAX_TURNS 保险丝。
 * 整个 agent 的唯一状态就是 messages 数组 —— 这是 pi 极简设计的核心。
 *
 * 本模块是组装者：编排 llm × tools；终端输出通过注入的 AgentUI 接口，
 * core 不知道终端的存在（依赖方向：cli/ → core/ → 适配层）。
 */
import type { Message, ToolResult, ToolUse } from "../types.ts";
import { getProvider } from "../config/index.ts";
import { callLLM } from "../llm/index.ts";
import { runTool, TOOLS } from "../tools/index.ts";

const MAX_TURNS = 100; // 保险丝：单个用户输入最多允许的工具调用轮数，防死循环

/**
 * agent 循环的终端输出接口，由 cli 层实现、main 装配时注入。
 * 所有着色/摘要渲染细节都在 cli/render.ts，core 只发语义事件。
 */
export interface AgentUI {
  text(delta: string): void; // 模型文本增量（流式）
  toolCall(tu: ToolUse): void; // 即将执行一个工具调用
  result(out: string, isError: boolean): void; // 工具结果预览
  info(s: string): void; // 弱提示（dim）：如 token 用量
  error(s: string): void; // 错误提示（red）
}

/** agentTurn 的运行上下文：系统提示词 + UI，由 main 构建后显式传入 */
export interface AgentContext {
  systemPrompt: string;
  ui: AgentUI;
}

/** 处理一轮用户输入的完整 agent 循环 */
export async function agentTurn(messages: Message[], ctx: AgentContext): Promise<void> {
  const { ui } = ctx;
  for (let turn = 0; ; turn++) {
    if (turn >= MAX_TURNS) {
      ui.error(`\n[stopped: reached max ${MAX_TURNS} turns]`);
      return;
    }
    // 请求 LLM；文本增量直接流式打印（协议细节在 callLLM 里，这里无感知）
    const res = await callLLM(getProvider(), ctx.systemPrompt, messages, TOOLS, ui.text);
    messages.push({ role: "assistant", content: res.content });
    const toolUses = res.content.filter((b): b is ToolUse => b.type === "tool_use");
    if (toolUses.length === 0) break; // 没有工具调用 → 本轮结束

    const results: ToolResult[] = [];
    for (const tu of toolUses) {
      ui.toolCall(tu);
      let out: string, isError = false;
      // pi 的关键保护：响应被 max_tokens 截断时，流式累积的工具参数可能是不完整的
      // JSON，执行有风险 —— 一律以错误回灌，让模型重新发起一次完整的工具调用
      if (res.stopReason === "max_tokens") {
        out = "Error: response hit the output token limit, so tool call arguments may be truncated. Re-issue the tool call with complete arguments.";
        isError = true;
      } else {
        try {
          out = await runTool(tu.name, tu.input);
        } catch (e) {
          out = `Error: ${e instanceof Error ? e.message : String(e)}`;
          isError = true;
        }
      }
      ui.result(out, isError);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: out, is_error: isError });
    }
    // tool_result 以 role:"user" 消息回灌（内部统一格式；OpenAI 路径发送时再转换）
    messages.push({ role: "user", content: results });
    ui.info(`  · tokens: ${res.usage.input} in / ${res.usage.output} out`);
  }
}
