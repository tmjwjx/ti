// 终端怎么把 agent 的事件画出来：颜色、工具参数一行摘要、结果预览
//
// ANSI：往字符串前后夹控制码，终端负责变色，例如 \x1b[31m 红、\x1b[0m 复位
// TTY：stdout 是不是交互终端。管道或重定向时 isTTY 为 false，颜色码会原样进文件，所以关掉
//
// 给模型的数据不在这里截：完整参数在 tc.arguments，完整结果在 messages
// 这里只缩短印到屏幕上的那一小段
import type { Message, ToolCall, UserMessage } from "../types.ts";
import type { AgentUI } from "../core/agent.ts";

const TTY = process.stdout.isTTY;
// 2 暗、36 青、31 红。非 TTY 原样返回，不夹控制码
const paint = (code: string, s: string) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = (s: string) => paint("2", s);
export const bold = (s: string) => paint("1", s);
export const cyan = (s: string) => paint("36", s);
export const red = (s: string) => paint("31", s);

// 调用前：压缩「入参」
// 例如 write 只印路径和字节数，不把整份文件内容打出来
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

// 把 agent 事件画成字
export function createTerminalUI(out?: { write(s: string): void; writeln(s: string): void }): AgentUI {
  // 不传 out 走 stdout：管道场景。TUI 传入后钉在视口，不能 console.log（会多换行）
  const write = out?.write ?? ((s) => process.stdout.write(s));
  const writeln = out?.writeln ?? ((s) => console.log(s));
  return {
    text: (d) => write(d), // 不换行，token 才能一个个流出来
    toolCall: (tc) => writeln(`  ${cyan("→")} ${tc.name}  ${dim(summarize(tc))}`),
    result: (outText, isError) => {
      // 屏幕只预览 5 行；完整结果已经在 messages 里给模型
      const lines = outText.split("\n");
      const head = lines.slice(0, 5).map((l) => "    " + l);
      if (lines.length > 5) head.push(`    … (${lines.length - 5} more lines)`);
      writeln((isError ? red : dim)(head.join("\n")));
    },
    info: (s) => writeln(dim(s)),
    error: (s) => writeln(red(s)),
  };
}

// 用户消息收成纯文本
function userText(m: UserMessage): string {
  if (typeof m.content === "string") return m.content;
  return m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

// 把已有历史按当时的样子画回屏幕。复用 createTerminalUI，跳过流转和 token 行
export function replayMessages(
  messages: Message[],
  out?: { write(s: string): void; writeln(s: string): void },
): void {
  const ui = createTerminalUI(out);
  const writeln = out?.writeln ?? ((s: string) => console.log(s));
  for (const m of messages) {
    if (m.role === "user") {
      let text = userText(m);
      if (text.length > 4000) text = text.slice(0, 4000) + "\n… (truncated)";
      writeln("");
      for (const [i, part] of text.split("\n").entries()) {
        writeln((i === 0 ? `${cyan("❯")} ` : "  ") + part);
      }
      continue;
    }
    if (m.role === "summary") {
      writeln(dim("[compacted summary]"));
      continue;
    }
    // 画成用户打的那一行，不铺全文
    if (m.role === "skill") {
      writeln("");
      writeln(`${cyan("❯")} /${m.name}${m.args ? ` ${m.args}` : ""}`);
      continue;
    }
    if (m.role === "assistant") {
      let hadText = false;
      for (const b of m.content) {
        if (b.type === "text" && b.text) {
          const text = b.text.length > 4000 ? b.text.slice(0, 4000) + "\n… (truncated)" : b.text;
          ui.text(text);
          hadText = true;
        }
      }
      if (hadText) writeln("");
      // 被打断的半截调用不会再执行，也不要画成已调用
      if (m.stopReason === "aborted") {
        writeln(dim("[interrupted]"));
        continue;
      }
      for (const b of m.content) {
        if (b.type === "toolCall") ui.toolCall(b);
      }
      continue;
    }
    ui.result(m.content, m.isError);
  }
}
