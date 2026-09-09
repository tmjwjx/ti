// 终端按键：一段原始字节 → 规范名（`up` `ctrl+c` `shift+enter`）
// 只解码，不解释含义。`ctrl+a` 是不是行首，由编辑器认
const SHIFT = 1;
const ALT = 2;
const CTRL = 4;

// 常见整段序列，最先查。同一键会有 CSI（`[`）和 SS3（`O`）两种写法
const NAMED: Record<string, string> = {
  "\x1b": "esc",
  "\r": "enter",
  "\n": "enter",
  "\t": "tab",
  "\x7f": "backspace",
  "\x08": "backspace",
  "\x1b[Z": "shift+tab",
  "\x1b\r": "shift+enter",
  "\x1b\n": "shift+enter",
  "\x1b[A": "up",
  "\x1bOA": "up",
  "\x1b[B": "down",
  "\x1bOB": "down",
  "\x1b[C": "right",
  "\x1bOC": "right",
  "\x1b[D": "left",
  "\x1bOD": "left",
  "\x1b[H": "home",
  "\x1bOH": "home",
  "\x1b[1~": "home",
  "\x1b[7~": "home",
  "\x1b[F": "end",
  "\x1bOF": "end",
  "\x1b[4~": "end",
  "\x1b[8~": "end",
  "\x1b[3~": "delete",
  "\x1b[5~": "page-up",
  "\x1b[6~": "page-down",
};

// kitty 协议里功能键的码点（方向、Home、End、小键盘回车）
const KITTY_FN: Record<number, string> = {
  27: "esc",
  13: "enter",
  9: "tab",
  127: "backspace",
  8: "backspace",
  57414: "enter",
  57417: "left",
  57418: "right",
  57419: "up",
  57420: "down",
  57421: "page-up",
  57422: "page-down",
  57423: "home",
  57424: "end",
  57425: "insert",
  57426: "delete",
};

// CSI 结尾：字母是方向，`~` 前的数字是 Home、Delete、Page
const CSI_LETTER: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};

const CSI_TILDE: Record<string, string> = {
  "1": "home",
  "3": "delete",
  "4": "end",
  "5": "page-up",
  "6": "page-down",
};

// 终端的 modifier 从 1 起：1 无修饰，2 shift，5 ctrl。减 1 才是 bit
function modBits(param: number): number {
  if (!Number.isFinite(param) || param < 1) return 0;
  return (param - 1) & (SHIFT | ALT | CTRL);
}

// 拼出 `ctrl+alt+shift+up`。没有修饰就只返回裸名字
function withMods(name: string, bits: number): string {
  const parts: string[] = [];
  if (bits & CTRL) parts.push("ctrl");
  if (bits & ALT) parts.push("alt");
  if (bits & SHIFT) parts.push("shift");
  return parts.length ? `${parts.join("+")}+${name}` : name;
}

// 码点 → 名字。字母一律小写，后面才能对上 `ctrl+a`
function codeName(code: number): string | undefined {
  if (KITTY_FN[code]) return KITTY_FN[code];
  if (code >= 65 && code <= 90) return String.fromCharCode(code + 32);
  if (code >= 97 && code <= 122) return String.fromCharCode(code);
  if (code >= 48 && code <= 57) return String.fromCharCode(code);
  if (code === 32) return " ";
  if (code >= 32 && code < 127) return String.fromCharCode(code);
  return undefined;
}

// 原始字节收成规范按键名
export function parseKey(data: string): string {
  // 整表 → kitty CSI u → modifyOtherKeys → 带修饰 CSI → Ctrl+字母
  if (NAMED[data]) return NAMED[data]!;

  // ESC [ <码点> ; <修饰> u。中间的 :shifted:base 和 :event 丢掉
  const kitty = data.match(/^\x1b\[(\d+)(?::[^;]*)?(?:;(\d+)(?::\d+)?)?u$/);
  if (kitty) {
    const name = codeName(Number(kitty[1]));
    if (name) return withMods(name, kitty[2] ? modBits(Number(kitty[2])) : 0);
  }

  // ESC [ 27 ; <修饰> ; <码点> ~
  const mok = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
  if (mok) {
    const name = codeName(Number(mok[2]));
    if (name) return withMods(name, modBits(Number(mok[1])));
  }

  // ESC [ 1 ; 5 C = ctrl+right。ESC [ 3 ; 2 ~ = shift+delete
  const csi = data.match(/^\x1b\[(?:(\d+);)?(\d+)([A-Z~])$/);
  if (csi) {
    const bits = csi[1] ? modBits(Number(csi[2])) : 0;
    const kind = csi[3];
    const name =
      kind === "~" ? CSI_TILDE[csi[1] ? csi[1] : csi[2]!] : CSI_LETTER[kind!];
    if (name) return withMods(name, bits);
  }

  // 单字节 0x01–0x1a 是 Ctrl+A–Z。\t \r \n 已在 NAMED
  if (data.length === 1) {
    const c = data.charCodeAt(0);
    if (c >= 1 && c <= 26) return `ctrl+${String.fromCharCode(c + 96)}`;
    return data;
  }

  return data;
}
