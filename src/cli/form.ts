// 全屏选项和单行输入
import { parseKey } from "./keys.ts";
import { bold, cyan, dim } from "./render.ts";

// 表单被强制中断
export class FormAbort extends Error {
  constructor() {
    super("aborted");
    this.name = "FormAbort";
  }
}

// 往终端写字，不额外换行
function writeRaw(s: string) {
  process.stdout.write(s);
}

export type Choice<T> = { value: T; label: string };

const HINT = "↑↓  enter  esc";
const INPUT_HINT = "enter  esc";

// raw 模式读按键直到结束
function readKeys(onKey: (key: string) => boolean): Promise<void> {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let esc = "";
    let escTimer: ReturnType<typeof setTimeout> | undefined;
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\x03") {
          cleanup();
          reject(new FormAbort());
          return;
        }
        if (esc) {
          if (escTimer) clearTimeout(escTimer);
          esc += ch;
          // CSI 或 SS3 以字母或 ~ 收尾，这时才交给 onKey
          if (/[A-Za-z~]/.test(ch)) {
            const key = esc;
            esc = "";
            if (onKey(key)) finish();
          }
          continue;
        }
        if (ch === "\x1b") {
          esc = ch;
          // 40ms 内没有后续就当单独 Esc
          escTimer = setTimeout(() => {
            esc = "";
            if (onKey("\x1b")) finish();
          }, 40);
          continue;
        }
        if (onKey(ch)) finish();
      }
    };
    // 摘掉监听；若进来前不是 raw，恢复，避免把后续 TUI 搞乱
    const cleanup = () => {
      if (escTimer) clearTimeout(escTimer);
      stdin.off("data", onData);
      if (!wasRaw) stdin.setRawMode?.(false);
      writeRaw("\x1b[?25h");
    };
    // 正常结束（选中或 Esc），与 Ctrl+C 的 reject 分开
    const finish = () => {
      cleanup();
      resolve();
    };
    stdin.on("data", onData);
  });
}

// 标题 + 一条与标题等宽的细线
function heading(title: string): string {
  const rule = "─".repeat(Math.max(16, displayLen(title) + 2));
  return `\n  ${bold(title)}\n  ${dim(rule)}\n\n`;
}

// 整屏画选项菜单
function paintMenu(title: string, labels: string[], index: number) {
  let out = "\x1b[?25l\x1b[H\x1b[J";
  out += heading(title);
  for (let i = 0; i < labels.length; i++) {
    const on = i === index;
    const mark = on ? cyan("▸") : dim(" ");
    const text = on ? bold(labels[i]!) : dim(labels[i]!);
    out += `  ${mark} ${text}\n`;
  }
  out += `\n  ${dim(HINT)}\n`;
  writeRaw(out);
}

// 全屏选项列表
export async function select<T>(title: string, choices: Choice<T>[], initial = 0): Promise<T | undefined> {
  if (!choices.length) return undefined;
  let index = Math.min(Math.max(0, initial), choices.length - 1);
  const draw = () => paintMenu(title, choices.map((c) => c.label), index);
  draw();
  let picked: T | undefined;
  let cancelled = false;
  await readKeys((raw) => {
    const key = parseKey(raw);
    if (key === "up" || key === "ctrl+p") {
      // JS 的 % 对负数仍为负，先加 length 再模，才能从 0 绕到末尾
      index = (index - 1 + choices.length) % choices.length;
      draw();
      return false;
    }
    if (key === "down" || key === "ctrl+n") {
      index = (index + 1) % choices.length;
      draw();
      return false;
    }
    if (key === "enter") {
      picked = choices[index]!.value;
      return true;
    }
    if (key === "esc") {
      cancelled = true;
      return true;
    }
    return false;
  });
  writeRaw("\x1b[?25h");
  if (cancelled) return undefined;
  return picked;
}

// 全屏单行输入
export async function input(title: string, opts?: { secret?: boolean; placeholder?: string }): Promise<string | undefined> {
  let value = "";
  let cursor = 0;
  // 按码点拆，避免 emoji 代理对被 splice 撕开
  const chars = () => [...value];
  // 整屏重画输入行，再把光标放到第 5 行（标题占了上面几行）
  const draw = () => {
    const cs = chars();
    const shown = opts?.secret ? "•".repeat(cs.length) : value;
    const placeholder = !value && opts?.placeholder ? dim(opts.placeholder) : "";
    writeRaw("\x1b[?25h\x1b[H\x1b[J");
    writeRaw(heading(title));
    writeRaw(`  ${cyan("│")} ${shown}${placeholder}\n`);
    writeRaw(`\n  ${dim(INPUT_HINT)}\n`);
    // • 都是 1 列；明文按 CJK 宽算。列 5 = 两个空格 + │ + 空格
    const before = opts?.secret ? cursor : displayLen(cs.slice(0, cursor).join(""));
    writeRaw(`\x1b[5;${5 + before}H`);
  };
  draw();
  let cancelled = false;
  let done = false;
  await readKeys((raw) => {
    const key = parseKey(raw);
    if (key === "enter") {
      done = true;
      return true;
    }
    if (key === "esc") {
      cancelled = true;
      return true;
    }
    if (key === "home" || key === "ctrl+a") {
      cursor = 0;
      draw();
      return false;
    }
    if (key === "end" || key === "ctrl+e") {
      cursor = chars().length;
      draw();
      return false;
    }
    if (key === "left" || key === "ctrl+b") {
      cursor = Math.max(0, cursor - 1);
      draw();
      return false;
    }
    if (key === "right" || key === "ctrl+f") {
      cursor = Math.min(chars().length, cursor + 1);
      draw();
      return false;
    }
    if (key === "ctrl+u") {
      value = chars().slice(cursor).join("");
      cursor = 0;
      draw();
      return false;
    }
    if (key === "delete") {
      const cs = chars();
      if (cursor >= cs.length) return false;
      cs.splice(cursor, 1);
      value = cs.join("");
      draw();
      return false;
    }
    if (key === "backspace" || key === "ctrl+h" || key === "ctrl+d") {
      if (cursor === 0) return false;
      const cs = chars();
      cs.splice(cursor - 1, 1);
      value = cs.join("");
      cursor -= 1;
      draw();
      return false;
    }
    if (key.length === 1 && key >= " ") {
      const cs = chars();
      cs.splice(cursor, 0, key);
      value = cs.join("");
      cursor += 1;
      draw();
      return false;
    }
    return false;
  });
  writeRaw("\x1b[?25h");
  if (cancelled) return undefined;
  if (done) return value;
  return undefined;
}

// 光标列：CJK 按 2 宽，用来把光标对准输入行
function displayLen(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w += c >= 0x1100 ? 2 : 1;
  }
  return w;
}
