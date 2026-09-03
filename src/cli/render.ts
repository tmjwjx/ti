/**
 * 终端怎么把 agent 的事件画出来：颜色、工具参数一行摘要、结果预览。
 *
 * ANSI：往字符串前后夹控制码，终端负责变色，例如 \x1b[31m 红、\x1b[0m 复位。
 * TTY：stdout 是不是交互终端。管道/重定向时 isTTY 为 false，颜色码会原样进文件，所以关掉。
 *
 * 给模型的数据不在这里截：完整参数在 tc.arguments，完整结果在 messages。
 * 这里只缩短印到屏幕上的那一小段。
 */
import type { ToolCall } from "../types.ts";
import type { AgentUI } from "../core/agent.ts";

const TTY = process.stdout.isTTY;
// 2 暗、36 青、31 红。非 TTY 原样返回，不夹控制码。
const paint = (code: string, s: string) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = (s: string) => paint("2", s);
export const cyan = (s: string) => paint("36", s);
export const red = (s: string) => paint("31", s);

/**
 * 调用前：压缩「入参」。
 * 例如 write 只印路径和字节数，不把整份文件内容打出来。
 */
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

/**
 * 调用后：压缩「返回结果」。
 * 终端只预览前 5 行；完整 out 已经推进 messages，给模型看。
 * 这不是模型说的话。模型正文走下面的 text()，全文流式打印、不截断。
 */
function printResult(out: string, isError: boolean) {
  const lines = out.split("\n");
  const head = lines.slice(0, 5).map((l) => "  " + l);
  if (lines.length > 5) head.push(`  … (${lines.length - 5} more lines)`);
  console.log((isError ? red : dim)(head.join("\n")));
}

/** 实现 AgentUI，main 里注入 agent。core 只回调这些函数，不自己 console.log。 */
export function createTerminalUI(): AgentUI {
  return {
    text: (d) => process.stdout.write(d), // write 不换行，才能一个字一个字流式出来
    toolCall: (tc) => console.log(`\n${cyan("→ " + tc.name)} ${dim(summarize(tc))}`),
    result: printResult,
    info: (s) => console.log(dim(s)),
    error: (s) => console.log(red(s)),
  };
}
