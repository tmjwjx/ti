/**
 * 终端渲染：ANSI 颜色、工具参数摘要、结果预览。
 * 非 TTY（管道/重定向）时颜色自动退化为纯文本。
 */
import type { ToolCall } from "../types.ts";
import type { AgentUI } from "../core/agent.ts";

const TTY = process.stdout.isTTY;
const paint = (code: string, s: string) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = (s: string) => paint("2", s);
export const cyan = (s: string) => paint("36", s);
export const red = (s: string) => paint("31", s);

/** 把工具调用参数压成一行摘要，便于扫读（bash 取命令、read 带分页区间……） */
function summarize(tc: ToolCall): string {
  const i = tc.arguments ?? {};
  switch (tc.name) {
    case "read":
      return `${i.path}${i.offset ? `:${i.offset}` : ""}${i.limit ? `,${i.limit}` : ""}`;
    case "write":
      return `${i.path} (${Buffer.byteLength(String(i.content ?? ""))} bytes)`;
    case "edit":
      return `${i.path} (${Array.isArray(i.edits) ? i.edits.length : "?"} edit(s))`;
    case "bash":
      return String(i.command ?? "").replace(/\s+/g, " ").slice(0, 120);
    default:
      return JSON.stringify(i).slice(0, 120);
  }
}

/** 工具结果只预览前 5 行（完整内容进模型上下文，但不刷屏）；错误用红色醒目显示 */
function printResult(out: string, isError: boolean) {
  const lines = out.split("\n");
  const head = lines.slice(0, 5).map((l) => "  " + l);
  if (lines.length > 5) head.push(`  … (${lines.length - 5} more lines)`);
  console.log((isError ? red : dim)(head.join("\n")));
}

/**
 * 创建 agent 循环的终端 UI 实现（AgentUI 接口的 cli 侧实现），
 * 由 main 装配时注入 core/agent.ts。
 */
export function createTerminalUI(): AgentUI {
  return {
    text: (d) => process.stdout.write(d),
    toolCall: (tc) => console.log(`\n${cyan("→ " + tc.name)} ${dim(summarize(tc))}`),
    result: printResult,
    info: (s) => console.log(dim(s)),
    error: (s) => console.log(red(s)),
  };
}
