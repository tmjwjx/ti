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
// 覆写走临时文件再 rename；追加后 fsync。同一份文件用 .lock 防两份 ti 互写
// agent 与 repl 不持有路径，只调导出函数
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { Message, StopReason, TextContent, ToolCall } from "../types.ts";
import { getProvider } from "../config/index.ts";

const META_VERSION = 1;
const HEX_LEN = 4;
const SLUG_CHARS = 40;
const MAX_BYTES = 32 * 1024 * 1024;
const LIST_HEAD = 64 * 1024;
const LIST_PARSE = 256 * 1024;
const DROP_WINDOW = 1024 * 1024;
const LOCK_TRIES = 5;
const REPAIR = "Error: missing tool result (session repaired)";
const STOPS = new Set<StopReason>(["stop", "length", "toolUse", "incomplete", "badArgs"]);

export type SessionInfo = {
  file: string;
  name: string;
  mtime: number;
  count: number;
};

export type SessionWriter = {
  file: string;
  name: string;
  append(entry: object): void;
  markCompact(): void;
  dropLast(): void;
};

let writer: SessionWriter | null = null;
let persistError: string | undefined;
let exitHooked = false;

// 记下最近一次落盘失败，给界面取走提示
function notePersist(e: unknown): void {
  persistError = e instanceof Error ? e.message : String(e);
}

// 取出并清空最近一次落盘失败
export function takePersistError(): string | undefined {
  const s = persistError;
  persistError = undefined;
  return s;
}

// 改权限，失败就忽略
function chmodQuiet(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // EPERM 或只读盘：留下现状，不要崩界面
  }
}

// writeSync 对大缓冲可能一次写不完，必须把剩余字节写完再 fsync
function writeAll(fd: number, data: string | Buffer): void {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw new Error("short write");
    off += n;
  }
}

// 从指定偏移把 size 读满。短读就再读，避免超大文件只拿到一半
function readAllAt(fd: number, size: number, position: number): Buffer {
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const n = readSync(fd, buf, off, size - off, position + off);
    if (n <= 0) throw new Error("short read");
    off += n;
  }
  return buf;
}

// 改名落稳后还要刷目录项，否则断电可能只看到旧名
function fsyncDir(file: string): void {
  try {
    const fd = openSync(dirname(file), "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Windows 上目录 fd 常常不能 fsync
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

// 首句收成文件名能用的一段
function slugify(text: string): string {
  const cleaned = firstLine(text)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\s/\\:*?"<>|]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return [...cleaned].slice(0, SLUG_CHARS).join("");
}

// 4 位 hex
function hex4(): string {
  return randomBytes(HEX_LEN / 2).toString("hex");
}

// 从现有文件名取出 hex 后缀。/rename 换 slug 时保留这一段
function hexOf(file: string): string {
  const m = basename(file).match(new RegExp(`_([0-9a-f]{${HEX_LEN}})\\.jsonl$`, "i"));
  return m ? m[1]!.toLowerCase() : hex4();
}

// 把 fd 刷到盘上再关
function fsyncClose(fd: number): void {
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// 独占建一份还不存在的 jsonl
function uniquePath(dir: string, slug: string): string {
  const tryName = (hex: string) => (slug ? `${slug}_${hex}.jsonl` : `_${hex}.jsonl`);
  for (let i = 0; i < 8; i++) {
    const file = join(dir, tryName(hex4()));
    try {
      const fd = openSync(file, "wx", 0o600);
      closeSync(fd);
      return file;
    } catch {
      // 撞名再抽
    }
  }
  const file = join(dir, tryName(randomBytes(4).toString("hex")));
  const fd = openSync(file, "wx", 0o600);
  closeSync(fd);
  return file;
}

// 进程还在不在。EPERM 表示存在但无权发信号，不能当成死锁去抢
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockPath(file: string): string {
  return file + ".lock";
}

// 占住这份会话，避免两份 ti 往同一文件追加
function acquireLock(file: string): void {
  const lock = lockPath(file);
  const body = `${process.pid}\n`;
  for (let i = 0; i < LOCK_TRIES; i++) {
    try {
      writeFileSync(lock, body, { flag: "wx", mode: 0o600 });
      return;
    } catch {
      // 已有锁，看是不是死的
    }
    let old = 0;
    try {
      old = parseInt(readFileSync(lock, "utf8"), 10);
    } catch {
      old = 0;
    }
    if (old === process.pid) return;
    if (old && pidAlive(old)) throw new Error("session is in use by another ti process");
    try {
      unlinkSync(lock);
    } catch {
      // 别人同时在抢
    }
  }
  throw new Error("session is in use by another ti process");
}

// 放下锁
function releaseLock(file: string): void {
  try {
    const lock = lockPath(file);
    const owner = parseInt(readFileSync(lock, "utf8"), 10);
    if (owner === process.pid) unlinkSync(lock);
  } catch {
    // 锁已经没了
  }
}

// 进程退出时丢掉锁，避免下次被活锁挡住
function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    if (writer) releaseLock(writer.file);
  });
}

// 建 .ti 与 sessions，权限收到 0o700
function ensureDir(dir: string): void {
  const parent = join(process.cwd(), ".ti");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodQuiet(parent, 0o700);
  chmodQuiet(dir, 0o700);
  ensureGitignore();
}

// 仓库里若还没忽略 .ti，补一行，避免会话和密钥被提交
function ensureGitignore(): void {
  if (!existsSync(join(process.cwd(), ".git"))) return;
  const gi = join(process.cwd(), ".gitignore");
  if (existsSync(gi)) {
    try {
      if (!statSync(gi).isFile()) return;
    } catch {
      return;
    }
  }
  let text = "";
  try {
    text = readFileSync(gi, "utf8");
  } catch {
    text = "";
  }
  if (/(?:^|[\n\r])\s*\.ti\/?\s*(?:[#\n\r]|$)/m.test(text)) return;
  const prefix = text && !text.endsWith("\n") ? "\n" : "";
  try {
    const fd = openSync(gi, "a", 0o644);
    writeAll(fd, prefix + ".ti/\n");
    fsyncClose(fd);
  } catch {
    // 忽略：只读仓库
  }
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

// 用法用量只收数字，缺了就当 0，避免 NaN 进下一轮请求
function asUsage(raw: any): { input: number; output: number } {
  const input = Number(raw?.input);
  const output = Number(raw?.output);
  return {
    input: Number.isFinite(input) ? input : 0,
    output: Number.isFinite(output) ? output : 0,
  };
}

// 把落盘对象收回内部 Message。缺字段或块形状不对的行丢掉，避免一份坏历史把下一轮协议打崩
function asMessage(raw: any): Message | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (raw.role === "user") {
    if (typeof raw.content === "string") return { role: "user", content: raw.content };
    if (Array.isArray(raw.content)) {
      const blocks: TextContent[] = [];
      for (const b of raw.content) {
        if (!b || b.type !== "text" || typeof b.text !== "string") return undefined;
        blocks.push({ type: "text", text: b.text });
      }
      return { role: "user", content: blocks };
    }
    return undefined;
  }
  if (raw.role === "assistant" && Array.isArray(raw.content)) {
    const content: (TextContent | ToolCall)[] = [];
    for (const b of raw.content) {
      if (!b || typeof b !== "object") return undefined;
      if (b.type === "text" && typeof b.text === "string") {
        content.push({ type: "text", text: b.text });
        continue;
      }
      if (b.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string") {
        const args = b.arguments && typeof b.arguments === "object" && !Array.isArray(b.arguments) ? b.arguments : {};
        content.push({ type: "toolCall", id: b.id, name: b.name, arguments: args });
        continue;
      }
      return undefined;
    }
    const stop = STOPS.has(raw.stopReason) ? raw.stopReason : "stop";
    return { role: "assistant", content, stopReason: stop, usage: asUsage(raw.usage) };
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

// 补上缺失的 toolResult，丢掉对不上的结果，避免恢复后下一轮 400
function repairMessages(messages: Message[]): Message[] {
  const out: Message[] = [];
  let pending: ToolCall[] = [];
  const flush = () => {
    for (const tc of pending) {
      out.push({ role: "toolResult", toolCallId: tc.id, toolName: tc.name, content: REPAIR, isError: true });
    }
    pending = [];
  };
  for (const m of messages) {
    if (m.role === "user") {
      flush();
      out.push(m);
      continue;
    }
    if (m.role === "assistant") {
      flush();
      out.push(m);
      pending = m.content.filter((b): b is ToolCall => b.type === "toolCall");
      continue;
    }
    const i = pending.findIndex((tc) => tc.id === m.toolCallId);
    if (i < 0) continue;
    pending.splice(i, 1);
    out.push(m);
  }
  flush();
  return out;
}

// 超大文件只读尾部，从整行边界切开。宁可少历史，不要一次读爆内存
function readText(file: string): string {
  const st = statSync(file);
  if (st.size <= MAX_BYTES) return readFileSync(file, "utf8");
  const fd = openSync(file, "r");
  try {
    const buf = readAllAt(fd, MAX_BYTES, st.size - MAX_BYTES);
    const text = buf.toString("utf8");
    const cut = text.indexOf("\n");
    return cut >= 0 ? text.slice(cut + 1) : text;
  } finally {
    closeSync(fd);
  }
}

// 读出全部带 type 的行。JSON 解不开的行跳过，不让一行毁一份
function readEntries(file: string): any[] {
  let text: string;
  try {
    text = readText(file);
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

// 封面在文件头。尾读大文件时 meta 会丢，所以单独看第一行
function metaVersion(file: string): number | undefined {
  try {
    const st = statSync(file);
    if (st.size <= 0) return undefined;
    const fd = openSync(file, "r");
    try {
      const text = readAllAt(fd, Math.min(4096, st.size), 0).toString("utf8");
      const raw = parseLine(text.split(/\r?\n/)[0] ?? "");
      if (raw?.type === "meta" && typeof raw.version === "number") return raw.version;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function assertReadable(file: string): void {
  const ver = metaVersion(file);
  if (ver !== undefined && ver > META_VERSION) {
    throw new Error(`session format v${ver} is newer than this ti`);
  }
}

// 整文件覆写：先写临时文件，fsync 再改名，避免写一半断电把原件截断
function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeAll(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    fsyncDir(file);
    chmodQuiet(file, 0o600);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 失败现场可能没建出临时文件
    }
    throw e;
  }
}

// 就地改 meta.name。jsonl 只能追加，改封面这一处只好整文件覆写
function rewriteMetaName(file: string, name: string): void {
  const st = statSync(file);
  if (st.size > MAX_BYTES) throw new Error(`session file exceeds ${MAX_BYTES} bytes`);
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = parseLine(lines[i]!);
    if (raw?.type === "meta") {
      lines[i] = JSON.stringify({ ...raw, name });
      atomicWrite(file, lines.join("\n"));
      return;
    }
  }
}

// 追加一行并 fsync。已有文件加上本行超过上限就拒绝，避免无限涨
function appendLine(file: string, line: string): void {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    size = 0;
  }
  const buf = Buffer.from(line);
  if (size + buf.length > MAX_BYTES) throw new Error(`session file exceeds ${MAX_BYTES} bytes`);
  // a+ 才能读最后一个字节。单用 a 是只写，read 会 EBADF，后面的消息全部落不了盘
  const fd = openSync(file, "a+", 0o600);
  try {
    // 上次写到一半时文件可能不以换行结尾。先隔开，避免新行粘到半截 JSON 上
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) writeAll(fd, "\n");
    }
    writeAll(fd, buf);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodQuiet(file, 0o600);
}

// 只截掉文件末尾最后一条完整 message。按字节找行，避免中文被按字符下标截断
function dropLastMessage(file: string): void {
  const st = statSync(file);
  if (st.size <= 0) return;
  const fd = openSync(file, "r+");
  try {
    let window = Math.min(st.size, DROP_WINDOW);
    let buf = readAllAt(fd, window, st.size - window);
    // 窗口落在一行中间时，开头不是完整行。放大到能看见这一行的换行，上限整文件
    while (st.size > window && buf.indexOf(0x0a) < 0) {
      if (window >= st.size) break;
      window = Math.min(st.size, window * 2);
      buf = readAllAt(fd, window, st.size - window);
    }
    const start = st.size - window;
    let from = 0;
    if (start > 0) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) throw new Error("session line exceeds rewrite window");
      from = nl + 1;
    }
    const region = buf.subarray(from);
    const lines: { at: number }[] = [];
    let lineAt = 0;
    for (let i = 0; i <= region.length; i++) {
      if (i === region.length || region[i] === 0x0a) {
        lines.push({ at: lineAt });
        lineAt = i + 1;
      }
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const at = lines[i]!.at;
      const end = i + 1 < lines.length ? lines[i + 1]!.at - 1 : region.length;
      if (end <= at) continue;
      let raw: any;
      try {
        raw = JSON.parse(region.subarray(at, end).toString("utf8"));
      } catch {
        raw = undefined;
      }
      // 半截行不是一条消息。只丢掉这段垃圾，不能把上一条完整 message 一起截掉
      if (!raw || typeof raw !== "object") {
        ftruncateSync(fd, start + from + at);
        fsyncSync(fd);
        return;
      }
      if (raw.type !== "message") return;
      ftruncateSync(fd, start + from + at);
      fsyncSync(fd);
      return;
    }
  } finally {
    closeSync(fd);
  }
}

// 挂在一份 jsonl 上的写入器。方法里用 this.file，/rename 改路径后追加仍进新文件
function makeWriter(file: string, name: string): SessionWriter {
  return {
    file,
    name,
    append(entry) {
      appendLine(this.file, JSON.stringify(entry) + "\n");
    },
    markCompact() {
      // 这版没有调用方。/compact 写出分隔后，loadMessages 会从这里切开
      this.append({ type: "compact", createdAt: new Date().toISOString() });
    },
    dropLast() {
      dropLastMessage(this.file);
    },
  };
}

// 当前工作目录下的 sessions 目录，不编码路径、不进 ~/.ti
export function sessionDir(): string {
  return join(process.cwd(), ".ti", "sessions");
}

// 路径必须落在当前 sessions 目录里，防止把任意文件当会话打开
export function isSessionPath(file: string): boolean {
  let dir = resolve(sessionDir());
  try {
    dir = realpathSync(dir);
  } catch {
    // sessions 还没建
  }
  let real = resolve(file);
  try {
    real = realpathSync(file);
  } catch {
    // 文件刚建、还没稳定
  }
  const rel = relative(dir, real);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
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
  hookExit();
  const dir = sessionDir();
  ensureDir(dir);
  const slug = name ? slugify(name) : "";
  const file = uniquePath(dir, slug);
  const display = name ? firstLine(name) : "";
  acquireLock(file);
  try {
    const w = makeWriter(file, display);
    w.append({
      type: "meta",
      version: META_VERSION,
      cwd: process.cwd(),
      ...providerMeta(),
      createdAt: new Date().toISOString(),
      name: display,
    });
    return w;
  } catch (e) {
    releaseLock(file);
    try {
      unlinkSync(file);
    } catch {
      // 建档失败时清掉空文件，避免列表里出现一份没写完的
    }
    throw e;
  }
}

// 接上已经存在的一份，不写新 meta。显示名：改过名用 meta.name，否则用首条用户句
export function openSession(file: string): SessionWriter {
  if (!isSessionPath(file)) throw new Error("session path is outside this project");
  assertReadable(file);
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
  hookExit();
  if (writer && writer.file === w.file) {
    writer = w;
    return;
  }
  // 先占新锁，失败则旧档仍握在手里，避免换档中途两头都没锁
  acquireLock(w.file);
  if (writer) releaseLock(writer.file);
  writer = w;
}

// 断开当前文件，磁盘上那份不动。下一句用户输入会再走 createSession
export function endSession(): void {
  if (writer) releaseLock(writer.file);
  writer = null;
}

// 读出可回放的对话。meta 与 compact 不当消息；形状对不上的补或丢
export function loadMessages(file: string): Message[] {
  if (!isSessionPath(file)) throw new Error("session path is outside this project");
  assertReadable(file);
  const out: Message[] = [];
  for (const raw of afterCompact(readEntries(file))) {
    if (raw.type !== "message") continue;
    const msg = asMessage(raw);
    if (msg) out.push(msg);
  }
  return repairMessages(out);
}

// 列表只要封面时只看文件头，避免为 10 个名字把整份历史 parse 一遍
function peekName(file: string): string {
  try {
    const st = statSync(file);
    const n = Math.min(st.size, LIST_HEAD);
    const fd = openSync(file, "r");
    let text = "";
    try {
      text = readAllAt(fd, n, 0).toString("utf8");
    } finally {
      closeSync(fd);
    }
    if (st.size > n) {
      const cut = text.lastIndexOf("\n");
      if (cut >= 0) text = text.slice(0, cut);
    }
    let metaName = "";
    let firstUser = "";
    for (const line of text.split(/\r?\n/)) {
      const raw = parseLine(line);
      if (!raw) continue;
      if (raw.type === "meta" && typeof raw.name === "string" && raw.name) metaName = raw.name;
      if (raw.type === "message" && raw.role === "user" && !firstUser) {
        const msg = asMessage(raw);
        if (msg && msg.role === "user") firstUser = firstLine(userText(msg));
      }
      if (metaName && firstUser) break;
    }
    return metaName || firstUser || basename(file, ".jsonl");
  } catch {
    return basename(file, ".jsonl");
  }
}

// 超大文件用换行数当条数上限，不把整份 JSON 解出来
function estimateCount(file: string): number {
  try {
    const st = statSync(file);
    const fd = openSync(file, "r");
    let lines = 0;
    const buf = Buffer.alloc(64 * 1024);
    try {
      let pos = 0;
      while (pos < st.size) {
        const n = readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        for (let i = 0; i < n; i++) if (buf[i] === 10) lines++;
        pos += n;
      }
    } finally {
      closeSync(fd);
    }
    return Math.max(0, lines - 1);
  } catch {
    return 0;
  }
}

// 只列当前目录，按 mtime 倒序。先按时间筛，再解析前几份，避免把整个目录读进内存
export function listSessions(limit = 10): SessionInfo[] {
  const dir = sessionDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const ranked: { file: string; mtime: number }[] = [];
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    const file = join(dir, n);
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      ranked.push({ file, mtime: st.mtimeMs });
    } catch {
      // 列表中途被删
    }
  }
  ranked.sort((a, b) => b.mtime - a.mtime);
  const items: SessionInfo[] = [];
  for (const row of ranked.slice(0, limit)) {
    try {
      const st = statSync(row.file);
      if (st.size <= LIST_PARSE) {
        const entries = readEntries(row.file);
        const live = afterCompact(entries);
        const meta = entries.find((e) => e.type === "meta");
        const first = live.find((e) => e.type === "message" && e.role === "user");
        items.push({
          file: row.file,
          name:
            (typeof meta?.name === "string" && meta.name) ||
            (first ? firstLine(userText(first as Message)) : "") ||
            basename(row.file, ".jsonl"),
          mtime: row.mtime,
          count: live.filter((e) => e.type === "message").length,
        });
      } else {
        items.push({
          file: row.file,
          name: peekName(row.file),
          mtime: row.mtime,
          count: estimateCount(row.file),
        });
      }
    } catch {
      // 读的时候被删
    }
  }
  return items;
}

// 对话状态的唯一入口：先推进内存，再追加一行
// writer 为空才建档，所以只敲斜杠命令就退出不会留空文件
export function pushMessage(messages: Message[], msg: Message): void {
  messages.push(msg);
  try {
    if (!writer) {
      const n = msg.role === "user" ? firstLine(userText(msg)) : undefined;
      writer = createSession(n || undefined);
    }
    writer.append({ type: "message", ...msg });
  } catch (e) {
    notePersist(e);
  }
}

// 撤回最后一条，数组与文件一起退。给「刚写下 user、请求还没写出 assistant 就失败」用
export function popMessage(messages: Message[]): void {
  messages.pop();
  try {
    writer?.dropLast();
  } catch (e) {
    notePersist(e);
  }
}

// 改显示名，文件跟着换成新 slug。hex 后缀尽量保留；目标已存在才另抽一串
export function renameSession(name: string): string | undefined {
  if (!writer) return undefined;
  const display = firstLine(name);
  if (!display) return writer.file;
  const prev = writer.file;
  try {
    const dir = sessionDir();
    const slug = slugify(display);
    let hex = hexOf(prev);
    let dest = join(dir, slug ? `${slug}_${hex}.jsonl` : `_${hex}.jsonl`);
    if (dest !== prev) {
      // link 撞名才换 hex。别的失败（不支持硬链接）重试也没用。POSIX rename 会覆盖，这里不能用
      let linked = false;
      for (let i = 0; i < 8; i++) {
        try {
          linkSync(prev, dest);
          linked = true;
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          hex = hex4();
          dest = join(dir, slug ? `${slug}_${hex}.jsonl` : `_${hex}.jsonl`);
        }
      }
      if (!linked) throw new Error("could not rename session");
      try {
        // 先拿新锁再放开旧名，避免中间有一段没人锁
        acquireLock(dest);
        unlinkSync(prev);
      } catch (e) {
        releaseLock(dest);
        try {
          unlinkSync(dest);
        } catch {
          // 新名字没留下
        }
        throw e;
      }
      releaseLock(prev);
      writer.file = dest;
      fsyncDir(dest);
    }
    rewriteMetaName(writer.file, display);
    writer.name = display;
    return writer.file;
  } catch (e) {
    notePersist(e);
    return undefined;
  }
}
