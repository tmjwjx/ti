// 主屏：对话视口、底栏编辑、footer
import { parseKey } from "./keys.ts";
import { bold, cyan, dim } from "./render.ts";

export type SlashCommand = { name: string; hint: string; label?: string; current?: boolean };
export type PaletteLookup = (input: string) => SlashCommand[] | null;
export type TuiChoice<T> = { value: T; label: string; current?: boolean };

export type Tui = {
  write(s: string): void;
  writeln(s: string): void;
  clear(): void;
  pause(): void;
  resume(): void;
  readLine(): Promise<string | null>;
  close(): void;
  setBusy(busy: boolean): void;
  setFooter(s: string): void;
  setCommands(cmds: SlashCommand[]): void;
  setLookup(fn: PaletteLookup): void;
  onInterrupt(fn: () => void): void;
  pick<T>(title: string, choices: TuiChoice<T>[], initial?: number): Promise<T | undefined>;
  ask(title: string, opts?: { secret?: boolean; placeholder?: string }): Promise<string | undefined>;
};

// 往终端写字
function writeRaw(s: string) {
  process.stdout.write(s);
}

// 一个字符占几列
function charWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (c <= 0x1f || c === 0x7f) return 0; // 控制字符
  // 东亚宽字符，大致对齐 wcwidth，不是完整 Unicode
  if (c >= 0x1100 && c <= 0x115f) return 2; // 韩文字母
  if (c === 0x2329 || c === 0x232a) return 2; // 角括号
  if (c >= 0x2e80 && c <= 0xa4cf) return 2; // CJK、假名、注音、彝文
  if (c >= 0xac00 && c <= 0xd7a3) return 2; // 韩文音节
  if (c >= 0xf900 && c <= 0xfaff) return 2; // 兼容汉字
  if (c >= 0xfe10 && c <= 0xfe6f) return 2; // 竖排、兼容、小型符号
  if (c >= 0xff00 && c <= 0xff60) return 2; // 全角
  if (c >= 0xffe0 && c <= 0xffe6) return 2; // 全角符号
  if (c >= 0x20000) return 2; // 补充平面
  return 1;
}

// 可见列宽
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch);
  return w;
}

// 去掉颜色码，避免把 ESC 序列算进宽度
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// 按列宽折一行
function wrapLine(text: string, width: number): string[] {
  if (width < 1) return [text];
  const out: string[] = [];
  let line = "";
  let w = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b") {
      const m = text.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        line += m[0];
        i += m[0].length;
        continue;
      }
    }
    const ch = text[i]!;
    i += 1;
    if (ch === "\n") {
      out.push(line);
      line = "";
      w = 0;
      continue;
    }
    const cw = charWidth(ch);
    if (w + cw > width && line) {
      out.push(line);
      line = "";
      w = 0;
    }
    line += ch;
    w += cw;
  }
  out.push(line);
  return out;
}

// 截到指定列宽并右垫
function fitWidth(text: string, width: number): string {
  if (width < 1) return "";
  let out = "";
  let w = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b") {
      const m = text.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const ch = text[i]!;
    const cw = charWidth(ch);
    if (w + cw > width) break;
    out += ch;
    w += cw;
    i += 1;
  }
  if (w < width) out += " ".repeat(width - w);
  return out;
}

type Vis = { text: string; start: number };

// 输入拆成视觉行
function visual(input: string, width: number): Vis[] {
  const chars = [...input];
  const lines: Vis[] = [];
  let line = "";
  let start = 0;
  let w = 0;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "\n") {
      lines.push({ text: line, start });
      line = "";
      w = 0;
      start = i + 1;
      continue;
    }
    const cw = charWidth(chars[i]!);
    if (w + cw > width && line) {
      lines.push({ text: line, start });
      line = "";
      w = 0;
      start = i;
    }
    line += chars[i];
    w += cw;
  }
  lines.push({ text: line, start });
  return lines;
}

// 光标落在哪条视觉行、该行第几列
function cursorView(input: string, cursor: number, width: number): { row: number; col: number; lines: Vis[] } {
  const lines = visual(input, width);
  let row = 0;
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1];
    if (!next || cursor < next.start) {
      row = i;
      break;
    }
    row = i;
  }
  const slice = [...input].slice(lines[row]!.start, cursor).join("");
  return { row, col: displayWidth(slice), lines };
}

// 编辑器按键绑定
const EDITOR: Record<string, string> = {
  "ctrl+a": "home-line",
  "ctrl+e": "end-line",
  "ctrl+u": "kill-left",
  "ctrl+k": "kill-right",
  "ctrl+h": "backspace",
  "ctrl+p": "up",
  "ctrl+n": "down",
  "ctrl+b": "left",
  "ctrl+f": "right",
  "ctrl+c": "ctrl-c",
  "ctrl+left": "word-left",
  "ctrl+right": "word-right",
  home: "home-line",
  end: "end-line",
  delete: "del-fwd",
  "shift+enter": "newline",
};

function decodeKey(raw: string): string {
  const k = parseKey(raw);
  return EDITOR[k] ?? k;
}

// 算不算一个词
function isWord(ch: string | undefined): boolean {
  return !!ch && /[0-9A-Za-z_\u4e00-\u9fff]/.test(ch);
}

// 打开主屏
export function openTui(): Tui {
  const stdin = process.stdin;
  const transcript: string[] = [];
  const history: string[] = [];
  let tail = "";
  let input = "";
  let cursor = 0;
  let histIdx = -1;
  let draft = "";
  let scroll = 0;
  let closed = false;
  let paused = false;
  let busy = false;
  let footer = "";
  let commands: SlashCommand[] = [];
  let lookup: PaletteLookup | undefined;
  let paletteIndex = 0;
  let paletteKind = "";
  let interrupt: (() => void) | undefined;
  // setup 挂在底栏时占用 editor。resolve 一次就收摊
  type Wizard = {
    kind: "pick";
    title: string;
    choices: TuiChoice<unknown>[];
    index: number;
    resolve: (v: unknown) => void;
  } | {
    kind: "ask";
    title: string;
    secret?: boolean;
    placeholder?: string;
    resolve: (v: unknown) => void;
  };
  let wizard: Wizard | null = null;
  let paintTimer: ReturnType<typeof setTimeout> | undefined;
  let prevFrame: string[] | null = null;
  let prevSize = { rows: 0, cols: 0 };
  let keysOn = false;
  let esc = "";
  let escTimer: ReturnType<typeof setTimeout> | undefined;
  const inbox: string[] = [];
  const waiters: ((s: string | null) => void)[] = [];

  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  // >4;2m：modifyOtherKeys，让 Ctrl 或 Shift+Enter 以 CSI u 进来，而不是裸 \r
  writeRaw("\x1b[?25h\x1b[>4;2m");

  const size = () => ({
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  });

  // 码点数组；cursor 是下标，不能用 input.length（代理对会算成 2）
  const chars = () => [...input];

  // 输入斜杠出命令列表；lookup 命中则换成 /model、/provider 二级。多行输入不弹
  const matches = () => {
    if (input.includes("\n") || !input.startsWith("/")) return [];
    const custom = lookup?.(input);
    // null = 不接管，走一级 /；[] = 接管但没匹配（输入 `/model zz` 时列表应空）
    if (custom) return custom;
    if (!commands.length) return [];
    const q = input.split(/\s/, 1)[0]!.toLowerCase();
    return commands.filter((c) => c.name.startsWith(q));
  };

  // 选中的是 /model 这种还能展开的命令，Enter 或 Tab 应先展开而不是立刻提交
  const submenu = (name: string) => {
    if (name.includes(" ")) return false;
    return !!((lookup?.(name)?.length ?? 0) || (lookup?.(name + " ")?.length ?? 0));
  };

  // 有人在等 readLine 就交给他；否则推进队列（模型还在跑时 Enter）。null 表示退出
  const deliver = (line: string | null) => {
    if (waiters.length) waiters.shift()!(line);
    else if (line !== null) inbox.push(line);
  };

  // close 时把所有挂起的 readLine 解开，避免 REPL 死等
  const flushWaiters = (line: string | null) => {
    while (waiters.length) waiters.shift()!(line);
  };

  // 换掉整段输入；默认光标到末尾
  const setInput = (s: string, cur?: number) => {
    input = s;
    cursor = cur ?? [...s].length;
  };

  // 收掉向导并交回值。undefined 是 Esc 或空 Ctrl+C。先清再 resolve，下一页才能马上再 pick
  const endWizard = (value: unknown) => {
    const done = wizard?.resolve;
    wizard = null;
    setInput("");
    paletteIndex = 0;
    paint();
    done?.(value);
  };

  // 在光标处插入。改过之后不再跟着历史条目走
  const insert = (text: string) => {
    const cs = chars();
    const add = [...text];
    cs.splice(cursor, 0, ...add);
    input = cs.join("");
    cursor += add.length;
    histIdx = -1;
    paletteIndex = 0;
  };

  // 当前逻辑行（两个换行之间）的起止，Ctrl+A、E、U、K 用这个而不是整份 input
  const lineBounds = () => {
    const cs = chars();
    let start = cursor;
    while (start > 0 && cs[start - 1] !== "\n") start -= 1;
    let end = cursor;
    while (end < cs.length && cs[end] !== "\n") end += 1;
    return { start, end, cs };
  };

  // 拼满屏一帧：transcript 视口 + 列表 + editor + footer
  // 尺寸变了整帧从 home 写；否则只重画变了的行（CSI 2026 包一层少闪）
  const paint = () => {
    if (closed || paused) return;
    const { rows, cols } = size();
    const boxInner = Math.max(1, cols - 6);
    // key 页只画 •，宽度按码点，和 cursor 对齐
    const shownInput = wizard?.kind === "ask" && wizard.secret ? "•".repeat([...input].length) : input;
    const viewIn = cursorView(shownInput, cursor, boxInner);
    const cap = Math.min(8, Math.max(1, rows - 6));
    let from = 0;
    if (viewIn.lines.length > cap) {
      from = Math.min(viewIn.row, viewIn.lines.length - cap);
      from = Math.max(0, from);
    }
    const shown = viewIn.lines.slice(from, from + cap);
    const cRow = viewIn.row - from;
    const inputRows = shown.length;
    const picking = wizard?.kind === "pick" ? wizard : null;
    const found = picking
      ? picking.choices.map((c, i) => ({
          name: String(i),
          label: c.label,
          hint: c.current ? "current" : "",
          current: !!c.current,
        }))
      : wizard
        ? [] // ask 时关掉斜杠列表，避免 key 里打 / 弹出命令
        : matches();
    const kind = picking
      ? "wizard"
      : found[0]?.name.startsWith("/model ")
        ? "model"
        : found[0]?.name.startsWith("/provider ")
          ? "provider"
          : found.length
            ? "cmd"
            : "";
    // 刚进二级列表时把光标落到 current，之后用户自己 ↑↓ 不再抢。向导用自己的 index
    if (!picking && kind !== paletteKind) {
      paletteKind = kind;
      const cur = found.findIndex((c) => c.current);
      paletteIndex = cur >= 0 ? cur : 0;
    }
    if (paletteIndex >= found.length) paletteIndex = Math.max(0, found.length - 1);
    const hi = picking ? picking.index : paletteIndex;
    const paletteMax = Math.min(found.length, Math.max(0, rows - inputRows - 5));
    const palFrom = found.length > paletteMax ? Math.max(0, Math.min(hi, found.length - paletteMax)) : 0;
    const palette = found.slice(palFrom, palFrom + paletteMax);
    const dock = 3 + inputRows + palette.length;
    const bodyRows = Math.max(1, rows - dock);

    const wrapped: string[] = [];
    for (const line of transcript) wrapped.push(...wrapLine(line, cols));
    if (tail) wrapped.push(...wrapLine(tail, cols));
    const maxScroll = Math.max(0, wrapped.length - bodyRows);
    if (scroll > maxScroll) scroll = maxScroll;
    const end = wrapped.length - scroll;
    const start = Math.max(0, end - bodyRows);
    const view = wrapped.slice(start, end);
    // 内容不够高时往上垫空行，最新一行贴在 editor 上方
    while (view.length < bodyRows) view.unshift("");

    const edge = dim("─".repeat(Math.max(0, cols - 2)));
    const top = dim("╭") + edge + dim("╮");
    const bot = dim("╰") + edge + dim("╯");
    const empty = !input;
    const emptyHint =
      wizard?.kind === "ask"
        ? wizard.placeholder || ""
        : wizard
          ? ""
          : busy
            ? "type to queue"
            : "message";
    const frame: string[] = [];
    for (const line of view) frame.push(fitWidth(line, cols));
    for (let i = 0; i < palette.length; i++) {
      const on = palFrom + i === hi;
      const active = !!palette[i]!.current;
      const mark = on ? cyan("▸") : active ? cyan("●") : dim(" ");
      const label = palette[i]!.label ?? palette[i]!.name;
      const name = on ? (active ? bold(cyan(label)) : cyan(label)) : active ? bold(label) : dim(label);
      const extra = palette[i]!.hint && palette[i]!.hint !== "current" ? palette[i]!.hint : "";
      const hint = active ? cyan("  current") : extra ? dim("  " + extra) : "";
      frame.push(fitWidth(`  ${mark} ${name}${hint}`, cols));
    }
    frame.push(fitWidth(top, cols));
    for (let i = 0; i < shown.length; i++) {
      const first = i === 0 && from === 0;
      const mark = first ? cyan("❯") : " ";
      let text = shown[i]!.text;
      if (empty && first) text = dim(emptyHint);
      const rawW = displayWidth(empty && first ? emptyHint : shown[i]!.text);
      const pad = Math.max(0, boxInner - rawW);
      frame.push(fitWidth(`${dim("│")} ${mark} ${text}${" ".repeat(pad)} ${dim("│")}`, cols));
    }
    frame.push(fitWidth(bot, cols));
    // 向导时 footer 只写页标题；平时才拼 queued 与 interrupt
    let foot = wizard ? wizard.title : footer;
    if (!wizard) {
      const extra: string[] = [];
      if (inbox.length) extra.push(`queued ${inbox.length}`);
      if (busy) extra.push("esc interrupt");
      if (extra.length) foot += (foot ? "  ·  " : "") + extra.join("  ·  ");
    }
    frame.push(fitWidth(" " + dim(foot), cols));
    while (frame.length < rows) frame.push(fitWidth("", cols));
    if (frame.length > rows) frame.length = rows;

    // 尺寸变了旧帧行列对不上，必须整屏重写；resume 后 prevFrame 已清空，也会走这条
    const resized = !prevFrame || prevSize.rows !== rows || prevSize.cols !== cols;
    // 2026 = synchronized update：整段写完再刷新，少闪。先藏光标
    let out = "\x1b[?2026h\x1b[?25l";
    if (resized) {
      out += "\x1b[H";
      for (let i = 0; i < frame.length; i++) {
        out += frame[i];
        if (i < frame.length - 1) out += "\n";
      }
    } else {
      for (let i = 0; i < frame.length; i++) {
        // 第 i+1 行列 1 写新行，K 清到行尾（防旧字比新行长时露出来）
        if (frame[i] !== prevFrame![i]) out += `\x1b[${i + 1};1H${frame[i]}\x1b[K`;
      }
    }
    out += "\x1b[?2026l";
    writeRaw(out);
    prevFrame = frame;
    prevSize = { rows, cols };
    // 框左缘占 4 列（│ 空格 ❯ 空格），光标列 = 5 + 视觉列
    const screenRow = bodyRows + palette.length + 1 + 1 + cRow;
    writeRaw(`\x1b[${screenRow};${Math.min(cols - 1, 5 + viewIn.col)}H\x1b[?25h`);
  };

  // 16ms 合并一次，流式 token 不会每字都刷屏
  const schedulePaint = () => {
    if (paintTimer) return;
    paintTimer = setTimeout(() => {
      paintTimer = undefined;
      paint();
    }, 16);
  };

  // 丢掉旧帧，强制下一画整屏。form 回来后必须走这里
  const invalidate = () => {
    prevFrame = null;
    paint();
  };

  const onResize = () => invalidate();
  process.stdout.on("resize", onResize);

  // 流式 write 先堆在 tail；遇到换行再推进 transcript，未完成的那截留着
  const flushTail = () => {
    if (!tail) return;
    const parts = tail.split("\n");
    tail = parts.pop() ?? "";
    for (const p of parts) transcript.push(p);
  };

  // 完整一行进 transcript，并滚回底部
  const writeln = (s: string) => {
    flushTail();
    if (tail) {
      transcript.push(tail);
      tail = "";
    }
    transcript.push(s);
    scroll = 0;
    schedulePaint();
  };

  // 恢复终端，解开所有 readLine。可重入。挂着的向导当取消
  const close = () => {
    if (closed) return;
    closed = true;
    if (paintTimer) clearTimeout(paintTimer);
    process.stdout.off("resize", onResize);
    detachKeys();
    stdin.setRawMode?.(false);
    stdin.pause();
    writeRaw("\x1b[>4;0m\x1b[?25h\n"); // 关掉 modifyOtherKeys，把光标还回去。
    if (wizard) {
      const done = wizard.resolve;
      wizard = null;
      done(undefined);
    }
    flushWaiters(null);
  };

  // 提交时先把用户那行画进 transcript，不用等 dispatch。忙时标 queued，字还在，只是进了队
  const echoUser = (line: string) => {
    if (!line) return;
    writeln("");
    const mark = busy ? dim("queued ❯") : cyan("❯");
    for (const [i, part] of line.split("\n").entries()) {
      writeln((i === 0 ? mark + " " : "  ") + part);
    }
  };

  // 清空 editor、入历史、echo，再 deliver。模型在跑也会立刻从框里消失
  const submit = (line: string) => {
    setInput("");
    histIdx = -1;
    draft = "";
    paletteIndex = 0;
    if (line.trim()) history.push(line);
    echoUser(line);
    paint();
    deliver(line);
  };

  // 按码点左右移，避免把代理对拆开
  const moveHoriz = (delta: number) => {
    cursor = Math.max(0, Math.min(chars().length, cursor + delta));
  };

  // 跳过空白再跳过一个词
  const moveWord = (dir: -1 | 1) => {
    const cs = chars();
    let i = cursor;
    if (dir < 0) {
      while (i > 0 && !isWord(cs[i - 1])) i -= 1;
      while (i > 0 && isWord(cs[i - 1])) i -= 1;
    } else {
      while (i < cs.length && !isWord(cs[i])) i += 1;
      while (i < cs.length && isWord(cs[i])) i += 1;
    }
    cursor = i;
  };

  // 视觉行上下移并尽量保持列。到头返回 false，交给历史翻页
  const lineMove = (dir: -1 | 1): boolean => {
    const { cols } = size();
    const inner = Math.max(1, cols - 6);
    const { row, col, lines } = cursorView(input, cursor, inner);
    const dest = row + dir;
    if (dest < 0 || dest >= lines.length) return false;
    const line = lines[dest]!;
    let acc = 0;
    let i = line.start;
    const cs = chars();
    while (i < cs.length && cs[i] !== "\n" && acc < col) {
      acc += charWidth(cs[i]!);
      i += 1;
    }
    const nextStart = lines[dest + 1]?.start ?? cs.length;
    cursor = Math.min(i, nextStart);
    return true;
  };

  // 上一条提交。第一次先把当前草稿存起来
  const historyPrev = () => {
    if (!history.length) return;
    if (histIdx === -1) {
      draft = input;
      histIdx = history.length - 1;
    } else if (histIdx > 0) histIdx -= 1;
    setInput(history[histIdx]!);
  };

  // 下一条；越过最新则回到草稿
  const historyNext = () => {
    if (histIdx === -1) return;
    if (histIdx < history.length - 1) {
      histIdx += 1;
      setInput(history[histIdx]!);
    } else {
      histIdx = -1;
      setInput(draft);
    }
  };

  // 删掉 [from, to)，光标落到 from。Ctrl+U、K 共用
  const deleteRange = (from: number, to: number) => {
    if (to <= from) return;
    const cs = chars();
    cs.splice(from, to - from);
    input = cs.join("");
    cursor = from;
    histIdx = -1;
  };

  // 一层按键。退出、打断、列表、编辑都在这
  // Ctrl+C：有字清空 → busy 打断 → 空闲退出。Esc：二级往回退 → 打断 → 清空
  const onKey = (raw: string) => {
    if (closed || paused) return;
    const key = decodeKey(raw);
    const found = wizard ? [] : matches(); // 向导期间不弹斜杠列表
    const paletteOpen = found.length > 0;

    // 列表向导：只认上下、回车、取消，打字不进框
    if (wizard?.kind === "pick") {
      if (key === "ctrl-c" || key === "esc") {
        endWizard(undefined);
        return;
      }
      if (key === "up") {
        wizard.index = (wizard.index - 1 + wizard.choices.length) % wizard.choices.length;
        paint();
        return;
      }
      if (key === "down") {
        wizard.index = (wizard.index + 1) % wizard.choices.length;
        paint();
        return;
      }
      if (key === "enter") {
        endWizard(wizard.choices[wizard.index]!.value);
        return;
      }
      if (key === "page-up") {
        scroll += Math.max(1, size().rows - 6);
        paint();
        return;
      }
      if (key === "page-down") {
        scroll = Math.max(0, scroll - Math.max(1, size().rows - 6));
        paint();
        return;
      }
      return;
    }

    if (key === "ctrl-c") {
      if (input) {
        setInput("");
        histIdx = -1;
        paletteIndex = 0;
        paint();
        return;
      }
      if (wizard) {
        endWizard(undefined);
        return;
      }
      if (busy) {
        interrupt?.();
        return;
      }
      close();
      return;
    }
    if (key === "esc") {
      if (wizard) {
        endWizard(undefined);
        return;
      }
      if (lookup?.(input)?.length) {
        // 二级 `/model foo` 先退到 `/model`；已经在 `/model` 再退到 `/`
        const head = input.split(/\s/, 1)[0]!;
        setInput(input === head ? "/" : head);
        paletteIndex = 0;
        paint();
        return;
      }
      if (paletteOpen && input !== "/") {
        setInput("/");
        paletteIndex = 0;
        paint();
        return;
      }
      if (busy) {
        interrupt?.();
        return;
      }
      if (input) {
        setInput("");
        histIdx = -1;
        paletteIndex = 0;
        paint();
      }
      return;
    }
    if (key === "newline") {
      if (wizard) return;
      insert("\n");
      paint();
      return;
    }
    if (key === "enter") {
      if (wizard?.kind === "ask") {
        endWizard(input);
        return;
      }
      if (paletteOpen && found[paletteIndex]) {
        const name = found[paletteIndex]!.name;
        // 还在一级（/mo）且该项有二级：展开成 `/model `，不要把 /model 当命令交出去
        if (!/\s/.test(input.trim()) && submenu(name)) {
          setInput(name + " ");
          paletteIndex = 0;
          paint();
          return;
        }
        submit(name);
        return;
      }
      submit(input);
      return;
    }
    if (key === "tab" && paletteOpen && found[paletteIndex]) {
      const name = found[paletteIndex]!.name;
      setInput(submenu(name) ? name + " " : name);
      paletteIndex = 0;
      paint();
      return;
    }
    if (key === "page-up") {
      scroll += Math.max(1, size().rows - 6);
      paint();
      return;
    }
    if (key === "page-down") {
      scroll = Math.max(0, scroll - Math.max(1, size().rows - 6));
      paint();
      return;
    }
    if (key === "up") {
      if (wizard) lineMove(-1);
      else if (paletteOpen) paletteIndex = (paletteIndex - 1 + found.length) % found.length;
      else if (!lineMove(-1)) historyPrev();
      paint();
      return;
    }
    if (key === "down") {
      if (wizard) lineMove(1);
      else if (paletteOpen) paletteIndex = (paletteIndex + 1) % found.length;
      else if (!lineMove(1)) historyNext();
      paint();
      return;
    }
    if (key === "left") {
      moveHoriz(-1);
      paint();
      return;
    }
    if (key === "right") {
      moveHoriz(1);
      paint();
      return;
    }
    if (key === "word-left") {
      moveWord(-1);
      paint();
      return;
    }
    if (key === "word-right") {
      moveWord(1);
      paint();
      return;
    }
    if (key === "home-line") {
      cursor = lineBounds().start;
      paint();
      return;
    }
    if (key === "end-line") {
      cursor = lineBounds().end;
      paint();
      return;
    }
    if (key === "kill-left") {
      const { start } = lineBounds();
      deleteRange(start, cursor);
      paint();
      return;
    }
    if (key === "kill-right") {
      const { end } = lineBounds();
      deleteRange(cursor, end);
      paint();
      return;
    }
    if (key === "del-fwd") {
      const cs = chars();
      if (cursor >= cs.length) return;
      cs.splice(cursor, 1);
      input = cs.join("");
      histIdx = -1;
      paint();
      return;
    }
    if (key === "ctrl+d") {
      if (!input) {
        if (wizard) return;
        close();
        return;
      }
    }
    if (key === "backspace" || key === "ctrl+d") {
      if (cursor === 0) return;
      const cs = chars();
      cs.splice(cursor - 1, 1);
      input = cs.join("");
      cursor -= 1;
      histIdx = -1;
      paletteIndex = 0;
      paint();
      return;
    }
    if (key.length === 1 && key >= " ") {
      insert(key);
      paint();
    }
  };

  // 拼 CSI：以 ESC 开头、以字母或 ~ 结束。40ms 内没有后续就当单独 Esc
  const onData = (chunk: string) => {
    for (const ch of chunk) {
      if (esc) {
        if (escTimer) clearTimeout(escTimer);
        esc += ch;
        if (/[A-Za-z~]/.test(ch)) {
          const key = esc;
          esc = "";
          onKey(key);
        }
        continue;
      }
      if (ch === "\x1b") {
        esc = ch;
        escTimer = setTimeout(() => {
          esc = "";
          onKey("\x1b");
        }, 40);
        continue;
      }
      onKey(ch);
    }
  };

  // 挂上 stdin。pause 或 close 会摘掉，resume 再挂，避免和 form 抢键
  function attachKeys() {
    if (keysOn || closed) return;
    keysOn = true;
    stdin.on("data", onData);
  }

  // 摘监听并丢掉半截 Esc，防止 resume 后吞进下一个键
  function detachKeys() {
    if (!keysOn) return;
    keysOn = false;
    stdin.off("data", onData);
    if (escTimer) clearTimeout(escTimer);
    esc = "";
  }

  attachKeys();
  paint();

  return {
    // 往对话区写流式字
    write(s: string) {
      tail += s;
      flushTail();
      scroll = 0;
      schedulePaint();
    },
    writeln,
    // 清对话区
    clear() {
      transcript.length = 0;
      tail = "";
      scroll = 0;
      schedulePaint();
    },
    // 把屏交给全屏 form
    pause() {
      paused = true;
      if (paintTimer) {
        clearTimeout(paintTimer);
        paintTimer = undefined;
      }
      detachKeys();
    },
    // 从全屏 form 回来
    resume() {
      paused = false;
      attachKeys();
      invalidate();
    },
    // 取下一行已提交的输入
    readLine() {
      return new Promise((resolve) => {
        if (closed) {
          resolve(null);
          return;
        }
        if (inbox.length) {
          resolve(inbox.shift()!);
          schedulePaint();
          return;
        }
        waiters.push(resolve);
      });
    },
    close,
    // 标记对话进行中
    setBusy(next) {
      busy = next;
      schedulePaint();
    },
    // 底栏选项列表
    pick(title, choices, initial = 0) {
      if (!choices.length) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        wizard = {
          kind: "pick",
          title,
          choices: choices as TuiChoice<unknown>[],
          index: Math.min(Math.max(0, initial), choices.length - 1),
          resolve: resolve as (v: unknown) => void,
        };
        setInput("");
        paint();
      });
    },
    // 底栏单行输入
    ask(title, opts) {
      return new Promise((resolve) => {
        wizard = {
          kind: "ask",
          title,
          secret: opts?.secret,
          placeholder: opts?.placeholder,
          resolve: resolve as (v: unknown) => void,
        };
        setInput("");
        paint();
      });
    },
    // 改底栏文案
    setFooter(s) {
      footer = s;
      schedulePaint();
    },
    // 斜杠命令列表
    setCommands(cmds) {
      commands = cmds;
    },
    // 斜杠输入的二级列表
    setLookup(fn) {
      lookup = fn;
    },
    // 注册打断回调
    onInterrupt(fn) {
      interrupt = fn;
    },
  };
}
