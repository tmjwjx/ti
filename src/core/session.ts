// 当前项目的对话落盘
//
// 文件在 <cwd>/.ti/sessions/，就是 process.cwd()，不往上找 git 根，所以 A、B 项目互不可见
// 一行一个 JSON，三种 type：
//   meta     建档时第一行。封面：当时的 cwd、厂家、显示名。loadMessages 会跳过，恢复也不按它切厂家
//   message  一条内部 Message 原样落盘（含 assistant.usage）。进出数组都走 pushMessage 或 popMessage
//   compact  压缩分隔，这版只留 markCompact。读的时候只取最后一个 compact 之后的 message
//
// writer 是模块级单例：null 表示还没建档（刚启动或刚 /clear）
// 第一次 pushMessage 才 createSession；/resume 是 bindSession(openSession(旧文件))
// agent 与 repl 不持有路径，只调这两个函数
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Message, TextContent } from "../types.ts";
import { getProvider } from "../config/index.ts";

// 列表里一项：name 优先 meta.name，否则首条用户句
export type SessionInfo = {
  file: string;
  name: string;
  mtime: number;
  count: number;
};

// 挂在一份 jsonl 上。file 会随 /rename 改
export type SessionWriter = {
  file: string;
  name: string;
  append(entry: object): void;
  markCompact(): void;
  dropLast(): void;
};

// null = 尚未建档或刚断档。所有落盘都问它
let writer: SessionWriter | null = null;

// 改权限，失败就忽略
function chmodQuiet(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // EPERM 或只读盘：留下现状，不要崩界面
  }
}

// 用户消息收成纯文本
function userText(msg: Message): string {
  if (msg.role !== "user") return "";
  if (typeof msg.content === "string") return msg.content;
  return msg.content.filter((b): b is TextContent => b.type === "text").map((b) => b.text).join("");
}

// 取第一行，去掉首尾空白
function firstLine(s: string): string {
  return (s.split(/\r?\n/)[0] ?? "").trim();
}

// 首句收成文件名能用的一段：空白和非法字符换横杠，连续横杠收成一个，按字截到 40
function slugify(text: string): string {
  const cleaned = firstLine(text)
    .replace(/[\s/\\:*?"<>|]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return [...cleaned].slice(0, 40).join("");
}

// 4 位 hex
function hex4(): string {
  return randomBytes(2).toString("hex");
}

// 从现有文件名取出 hex 后缀。/rename 换 slug 时保留这一段，避免两份文件抢同一个短名
function hexOf(file: string): string {
  const m = basename(file).match(/_([0-9a-f]{4})\.jsonl$/i);
  return m ? m[1]!.toLowerCase() : hex4();
}

// 拼一份还不存在的 jsonl 路径。空 slug 写成 _<hex>.jsonl，避免文件名以 _ 前的空串开头不好认
function uniquePath(dir: string, slug: string): string {
  for (let i = 0; i < 8; i++) {
    const hex = hex4();
    const name = slug ? `${slug}_${hex}.jsonl` : `_${hex}.jsonl`;
    const file = join(dir, name);
    if (!existsSync(file)) return file;
  }
  const name = slug ? `${slug}_${randomBytes(4).toString("hex")}.jsonl` : `_${randomBytes(4).toString("hex")}.jsonl`;
  return join(dir, name);
}

// 建 .ti 与 sessions，权限收到 0o700
function ensureDir(dir: string): void {
  const parent = join(process.cwd(), ".ti");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodQuiet(parent, 0o700);
  chmodQuiet(dir, 0o700);
}

// 写进 meta 的厂家快照。读不到就空着；恢复时不会拿来 setProvider
function providerMeta(): { provider?: string; model?: string } {
  try {
    const p = getProvider();
    return { provider: p.name, model: p.model };
  } catch {
    return {};
  }
}

// 一行 json 解出来，坏行是 undefined
function parseLine(line: string): any | undefined {
  const t = line.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

// 把落盘对象收回内部 Message。缺字段的行丢掉，避免一份坏历史把下一轮协议打崩
function asMessage(raw: any): Message | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (raw.role === "user" && "content" in raw) {
    return { role: "user", content: raw.content };
  }
  if (raw.role === "assistant" && Array.isArray(raw.content)) {
    return {
      role: "assistant",
      content: raw.content,
      stopReason: raw.stopReason ?? "stop",
      usage: raw.usage ?? { input: 0, output: 0 },
    };
  }
  if (raw.role === "toolResult" && typeof raw.toolCallId === "string") {
    return {
      role: "toolResult",
      toolCallId: raw.toolCallId,
      toolName: typeof raw.toolName === "string" ? raw.toolName : "",
      content: String(raw.content ?? ""),
      isError: !!raw.isError,
    };
  }
}

// 读出全部带 type 的行。JSON 解不开的行跳过，不让一行毁一份
function readEntries(file: string): any[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: any[] = [];
  for (const line of text.split(/\r?\n/)) {
    const raw = parseLine(line);
    if (raw && typeof raw.type === "string") out.push(raw);
  }
  return out;
}

// 只留最后一个 compact 之后。/compact 真压缩时，标记之前的原文仍在文件里，恢复只吃压缩后的尾巴
function afterCompact(entries: any[]): any[] {
  let from = 0;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type === "compact") from = i + 1;
  }
  return entries.slice(from);
}

// 整文件覆写，权限收到 0o600
function writeLines(file: string, lines: string[]): void {
  writeFileSync(file, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
  chmodQuiet(file, 0o600);
}

// 就地改 meta.name。jsonl 只能追加，改封面这一处只好整文件覆写
function rewriteMetaName(file: string, name: string): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = parseLine(lines[i]!);
    if (raw?.type === "meta") {
      lines[i] = JSON.stringify({ ...raw, name });
      writeLines(file, lines);
      return;
    }
  }
}

// 挂在一份 jsonl 上的写入器。方法里用 this.file，/rename 改路径后追加仍进新文件
function makeWriter(file: string, name: string): SessionWriter {
  return {
    file,
    name,
    append(entry) {
      appendFileSync(this.file, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600 });
      chmodQuiet(this.file, 0o600);
    },
    markCompact() {
      // 这版没有调用方。/compact 写出分隔后，loadMessages 会从这里切开
      this.append({ type: "compact", createdAt: new Date().toISOString() });
    },
    dropLast() {
      let text: string;
      try {
        text = readFileSync(this.file, "utf8");
      } catch {
        return;
      }
      const lines = text.split("\n");
      // 只撤 message，碰到 meta 或 compact 停。失败撤回时最后一行就是刚写下的 user
      for (let i = lines.length - 1; i >= 0; i--) {
        const raw = parseLine(lines[i]!);
        if (raw?.type === "message") {
          lines.splice(i, 1);
          writeLines(this.file, lines);
          return;
        }
      }
    },
  };
}

// 当前工作目录下的 sessions 目录，不编码路径、不进 ~/.ti
export function sessionDir(): string {
  return join(process.cwd(), ".ti", "sessions");
}

// 正在写的那份路径
export function sessionFile(): string | undefined {
  return writer?.file;
}

// 正在写的那份显示名
export function sessionName(): string | undefined {
  return writer?.name;
}

// 建一份新 jsonl。name 来自首条用户句，同时用于文件名 slug 和 meta.name
export function createSession(name?: string): SessionWriter {
  const dir = sessionDir();
  ensureDir(dir);
  const slug = name ? slugify(name) : "";
  const file = uniquePath(dir, slug);
  const display = name ? firstLine(name) : "";
  const w = makeWriter(file, display);
  // 封面行。loadMessages 按 type 跳过它；列表和 /rename 只动 name
  w.append({
    type: "meta",
    version: 1,
    cwd: process.cwd(),
    ...providerMeta(),
    createdAt: new Date().toISOString(),
    name: display,
  });
  return w;
}

// 接上已经存在的一份，不写新 meta。显示名：改过名用 meta.name，否则用首条用户句
export function openSession(file: string): SessionWriter {
  const entries = readEntries(file);
  const meta = entries.find((e) => e.type === "meta");
  const first = afterCompact(entries).find((e) => e.type === "message" && e.role === "user");
  const name =
    (typeof meta?.name === "string" && meta.name) ||
    (first ? firstLine(userText(first as Message)) : "") ||
    basename(file, ".jsonl");
  return makeWriter(file, name);
}

// 把模块级 writer 指到这份。之后 push 与 pop 都进它
export function bindSession(w: SessionWriter): void {
  writer = w;
}

// 断开当前文件，磁盘上那份不动。下一句用户输入会再走 createSession
export function endSession(): void {
  writer = null;
}

// 读出可回放的对话。meta 与 compact 不当消息；形状对不上的 message 也丢
export function loadMessages(file: string): Message[] {
  const out: Message[] = [];
  for (const raw of afterCompact(readEntries(file))) {
    if (raw.type !== "message") continue;
    const msg = asMessage(raw);
    if (msg) out.push(msg);
  }
  return out;
}

// 只列当前目录，按 mtime 倒序。目录不存在当作没有，不建空文件夹
export function listSessions(limit = 10): SessionInfo[] {
  const dir = sessionDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const items: SessionInfo[] = [];
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    const file = join(dir, n);
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const entries = readEntries(file);
    const live = afterCompact(entries);
    const meta = entries.find((e) => e.type === "meta");
    const first = live.find((e) => e.type === "message" && e.role === "user");
    // 改过名的会话文件名和首句可能对不上，列表以 meta.name 为准
    const name =
      (typeof meta?.name === "string" && meta.name) ||
      (first ? firstLine(userText(first as Message)) : "") ||
      n.slice(0, -6);
    const count = live.filter((e) => e.type === "message").length;
    items.push({ file, name, mtime, count });
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return items.slice(0, limit);
}

// 对话状态的唯一入口：先推进内存，再追加一行
// writer 为空才建档，所以只敲斜杠命令就退出不会留空文件
export function pushMessage(messages: Message[], msg: Message): void {
  messages.push(msg);
  try {
    if (!writer) {
      // 文件名取首条用户句。第一条通常就是 user；若不是，先用 hex 顶上
      const n = msg.role === "user" ? firstLine(userText(msg)) : undefined;
      writer = createSession(n || undefined);
    }
    writer.append({ type: "message", ...msg });
  } catch {
    // 磁盘出错只降级为不落盘，不能把对话打断
  }
}

// 撤回最后一条，数组与文件一起退。给「刚写下 user、请求还没写出 assistant 就失败」用
export function popMessage(messages: Message[]): void {
  messages.pop();
  try {
    writer?.dropLast();
  } catch {
    // 同上
  }
}

// 改显示名，文件跟着换成新 slug。hex 后缀尽量保留；目标已存在才另抽一串
export function renameSession(name: string): string | undefined {
  if (!writer) return undefined;
  const display = firstLine(name);
  if (!display) return writer.file;
  try {
    rewriteMetaName(writer.file, display);
    const dir = sessionDir();
    const slug = slugify(display);
    let hex = hexOf(writer.file);
    let dest = join(dir, slug ? `${slug}_${hex}.jsonl` : `_${hex}.jsonl`);
    if (dest !== writer.file && existsSync(dest)) {
      hex = hex4();
      dest = join(dir, slug ? `${slug}_${hex}.jsonl` : `_${hex}.jsonl`);
    }
    if (dest !== writer.file) {
      renameSync(writer.file, dest);
      writer.file = dest;
    }
    writer.name = display;
    return writer.file;
  } catch {
    return undefined;
  }
}
