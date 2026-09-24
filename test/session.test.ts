// core/session.ts：当前目录 jsonl 的建档、追加、撤回、压缩切口、恢复修补、改名、列表与锁
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Message } from "../src/types.ts";
import { isolate } from "./helpers.ts";

const box = isolate();
const { setProvider } = await import("../src/config/index.ts");
const s = await import("../src/core/session.ts");

const dir = join(box.project, ".ti", "sessions");
const SESSION_MAX = 32 * 1024 * 1024;

// 读出 jsonl 的每一行（不含末尾空行）
function lines(file: string): string[] {
  return readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
}

// 读出 jsonl 里解析得开的每一行对象
function entries(file: string): any[] {
  return lines(file).map((l) => JSON.parse(l));
}

// 在 sessions 目录里手写一份 jsonl，行是对象或原样字符串
function writeSession(name: string, rows: (object | string)[]): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  return file;
}

// 一行 meta 封面
function meta(extra: object = {}): object {
  return { type: "meta", version: 1, cwd: box.project, createdAt: "2026-01-01T00:00:00.000Z", name: "", ...extra };
}

// 一行 message
function msg(m: object): object {
  return { type: "message", ...m };
}

// 按字节读一段。大文件只核对头尾，避免断言把整份打出来
function readSlice(file: string, length: number, position: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, position);
    assert.equal(n, length);
    return buf;
  } finally {
    closeSync(fd);
  }
}

// 这次压缩要追加的字节数。时间戳长度固定，用来把文件填到刚好超限
function plannedBytes(summary: { role: "summary"; text: string; files: { read: string[]; modified: string[] } }, kept: Message[]): number {
  let n = Buffer.byteLength(JSON.stringify({ type: "compact", createdAt: new Date().toISOString() }) + "\n");
  n += Buffer.byteLength(JSON.stringify({ type: "message", ...summary }) + "\n");
  for (const m of kept) n += Buffer.byteLength(JSON.stringify({ type: "message", ...m }) + "\n");
  return n;
}

// 已经退出的进程号，用来模拟死锁
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

beforeEach(() => {
  s.endSession();
  s.takePersistError();
  rmSync(join(box.project, ".ti"), { recursive: true, force: true });
});

describe("inputText", () => {
  test("user 取文本，块数组拼起来；skill 还原成 /名字 参数；其它角色是空串", () => {
    assert.equal(s.inputText({ role: "user", content: "hi" }), "hi");
    assert.equal(s.inputText({ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "ab");
    assert.equal(s.inputText({ role: "skill", name: "rev", path: "/p", body: "B", args: "x y" }), "/rev x y");
    assert.equal(s.inputText({ role: "skill", name: "rev", path: "/p", body: "B", args: "" }), "/rev");
    assert.equal(s.inputText({ role: "assistant", content: [{ type: "text", text: "no" }], stopReason: "stop", usage: { input: 0, output: 0 } }), "");
    assert.equal(s.inputText({ role: "summary", text: "S", files: { read: [], modified: [] } }), "");
    assert.equal(s.inputText({ role: "toolResult", toolCallId: "c", toolName: "t", content: "r", isError: false }), "");
  });
});

describe("pushMessage 建档与追加", () => {
  test("第一条才建档，文件名取首句 slug + 4 位 hex，meta 是第一行", () => {
    const messages: Message[] = [];
    assert.equal(s.sessionFile(), undefined);
    s.pushMessage(messages, { role: "user", content: "Fix the bug: now/please\nsecond line" });
    const file = s.sessionFile()!;
    assert.equal(messages.length, 1);
    assert.match(basename(file), /^Fix-the-bug-now-please_[0-9a-f]{4}\.jsonl$/);
    assert.equal(file, join(dir, basename(file)));
    assert.equal(s.sessionName(), "Fix the bug: now/please");
    const [head, first] = entries(file);
    assert.equal(head.type, "meta");
    assert.equal(head.version, 1);
    assert.equal(head.cwd, box.project);
    assert.equal(head.name, "Fix the bug: now/please");
    assert.ok(!Number.isNaN(Date.parse(head.createdAt)));
    assert.deepEqual(first, { type: "message", role: "user", content: "Fix the bug: now/please\nsecond line" });
  });

  test("meta 记下当前厂家与模型", () => {
    setProvider({ name: "deepseek", protocol: "openai", baseURL: "x", model: "m1", apiKey: "k", auth: "bearer" });
    s.pushMessage([], { role: "user", content: "hello" });
    const head = entries(s.sessionFile()!)[0];
    assert.equal(head.provider, "deepseek");
    assert.equal(head.model, "m1");
  });

  test("目录 0700、文件 0600", () => {
    s.pushMessage([], { role: "user", content: "perm" });
    assert.equal(statSync(join(box.project, ".ti")).mode & 0o777, 0o700);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(s.sessionFile()!).mode & 0o777, 0o600);
  });

  test("skill 作为第一条时按 /名字 参数 命名", () => {
    s.pushMessage([], { role: "skill", name: "review", path: "/p/SKILL.md", body: "B", args: "src dir" });
    assert.match(basename(s.sessionFile()!), /^review-src-dir_[0-9a-f]{4}\.jsonl$/);
    assert.equal(s.sessionName(), "/review src dir");
  });

  test("slug 去掉头尾的点和横线，中文保留，截到 40 个字", () => {
    s.pushMessage([], { role: "user", content: `...${"修".repeat(50)}` });
    const name = basename(s.sessionFile()!);
    assert.match(name, new RegExp(`^${"修".repeat(40)}_[0-9a-f]{4}\\.jsonl$`));
  });

  test("首句为空时文件名只有 _hex", () => {
    s.pushMessage([], { role: "user", content: "   " });
    assert.match(basename(s.sessionFile()!), /^_[0-9a-f]{4}\.jsonl$/);
    assert.equal(s.sessionName(), "");
  });

  test("后续消息追加成一行一条，内存与文件同步", () => {
    const messages: Message[] = [];
    s.pushMessage(messages, { role: "user", content: "q" });
    s.pushMessage(messages, { role: "assistant", content: [{ type: "text", text: "a" }], stopReason: "stop", usage: { input: 3, output: 4 } });
    const file = s.sessionFile()!;
    assert.equal(lines(file).length, 3);
    assert.deepEqual(s.loadMessages(file), messages);
  });

  test("文件末尾没换行时，下一次追加先补换行，半截行之后的新消息仍读得出", () => {
    const messages: Message[] = [];
    s.pushMessage(messages, { role: "user", content: "one" });
    const file = s.sessionFile()!;
    appendFileSync(file, '{"type":"message","role":"user","content":"半截');
    s.pushMessage(messages, { role: "user", content: "two" });
    const raw = readFileSync(file, "utf8");
    assert.ok(raw.endsWith('半截\n{"type":"message","role":"user","content":"two"}\n'));
    assert.deepEqual(s.loadMessages(file), [
      { role: "user", content: "one" },
      { role: "user", content: "two" },
    ]);
  });

  test("落盘失败不抛，内存照样推进，错误由 takePersistError 取走一次", { skip: process.getuid?.() === 0 }, () => {
    const messages: Message[] = [];
    s.pushMessage(messages, { role: "user", content: "a" });
    const file = s.sessionFile()!;
    chmodSync(file, 0o400);
    try {
      s.pushMessage(messages, { role: "user", content: "b" });
      assert.equal(messages.length, 2);
      assert.match(s.takePersistError() ?? "", /EACCES|permission/i);
      assert.equal(s.takePersistError(), undefined);
    } finally {
      chmodSync(file, 0o600);
    }
  });

  test("文件超过 32MB 拒绝再追加", () => {
    const messages: Message[] = [];
    s.pushMessage(messages, { role: "user", content: "a" });
    const file = s.sessionFile()!;
    truncateSync(file, 32 * 1024 * 1024 - 10);
    s.pushMessage(messages, { role: "user", content: "this line is too long to fit" });
    assert.equal(s.takePersistError(), `session file exceeds ${32 * 1024 * 1024} bytes`);
    assert.equal(statSync(file).size, 32 * 1024 * 1024 - 10);
  });
});

describe("popMessage", () => {
  test("撤回最后一条：内存与文件一起退，中文按字节截不乱", () => {
    const messages: Message[] = [];
    s.pushMessage(messages, { role: "user", content: "你好，世界" });
    s.pushMessage(messages, { role: "user", content: "第二句🙂" });
    const file = s.sessionFile()!;
    s.popMessage(messages);
    assert.deepEqual(messages, [{ role: "user", content: "你好，世界" }]);
    assert.equal(lines(file).length, 2);
    assert.ok(readFileSync(file, "utf8").endsWith('"你好，世界"}\n'));
    assert.deepEqual(s.loadMessages(file), messages);
    // 撤回之后再追加仍然是合法的一行
    s.pushMessage(messages, { role: "user", content: "again" });
    assert.deepEqual(s.loadMessages(file), messages);
  });

  test("末尾是半截行时只截掉那段垃圾，上一条完整消息保留", () => {
    const messages: Message[] = [];
    s.pushMessage(messages, { role: "user", content: "keep me" });
    const file = s.sessionFile()!;
    appendFileSync(file, '{"type":"message","role":"user","content":"中');
    s.popMessage(messages);
    assert.equal(messages.length, 0);
    assert.ok(readFileSync(file, "utf8").endsWith('"keep me"}\n'));
    assert.deepEqual(s.loadMessages(file), [{ role: "user", content: "keep me" }]);
  });

  test("最后一行是 meta 或 compact 时不动文件", () => {
    const messages: Message[] = [];
    s.pushMessage(messages, { role: "user", content: "x" });
    const file = s.sessionFile()!;
    s.commitCompact({ role: "summary", text: "S", files: { read: [], modified: [] } }, []);
    // commitCompact 在分隔后写了摘要，先把摘要撤掉，末行就是 compact
    s.popMessage([]);
    const before = readFileSync(file, "utf8");
    assert.equal(JSON.parse(lines(file).at(-1)!).type, "compact");
    s.popMessage([]);
    assert.equal(readFileSync(file, "utf8"), before);
  });

  test("追加失败后撤回不截文件，上一条还在", { skip: process.getuid?.() === 0 }, () => {
    const messages: Message[] = [];
    s.pushMessage(messages, { role: "user", content: "keep" });
    const file = s.sessionFile()!;
    const before = readFileSync(file, "utf8");
    chmodSync(file, 0o400);
    try {
      s.pushMessage(messages, { role: "user", content: "lost" });
    } finally {
      chmodSync(file, 0o600);
    }
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(messages.length, 2);
    s.popMessage(messages);
    assert.deepEqual(messages, [{ role: "user", content: "keep" }]);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.deepEqual(s.loadMessages(file), messages);
    // 失败那条没落盘，后面成功写入的撤回仍只截刚写的一行
    s.pushMessage(messages, { role: "user", content: "next" });
    s.popMessage(messages);
    assert.deepEqual(messages, [{ role: "user", content: "keep" }]);
    assert.deepEqual(s.loadMessages(file), messages);
  });

  test("还没建档时只退内存", () => {
    const messages: Message[] = [{ role: "user", content: "mem" }];
    s.popMessage(messages);
    assert.deepEqual(messages, []);
    assert.equal(s.sessionFile(), undefined);
    assert.equal(existsSync(dir), false);
  });
});

describe("压缩切口与 loadMessages", () => {
  test("commitCompact 写 compact 分隔、摘要、保留段；load 只取最后一个分隔之后", () => {
    const messages: Message[] = [];
    s.pushMessage(messages, { role: "user", content: "old question" });
    s.pushMessage(messages, { role: "assistant", content: [{ type: "text", text: "old answer" }], stopReason: "stop", usage: { input: 1, output: 1 } });
    s.pushMessage(messages, { role: "user", content: "recent" });
    const file = s.sessionFile()!;
    const summary = { role: "summary" as const, text: "SUM1", files: { read: ["a"], modified: [] } };
    s.commitCompact(summary, [messages[2]!]);
    const rows = entries(file);
    assert.deepEqual(
      rows.slice(4).map((r) => r.type + (r.role ? `:${r.role}` : "")),
      ["compact", "message:summary", "message:user"],
    );
    assert.ok(!Number.isNaN(Date.parse(rows[4].createdAt)));
    assert.deepEqual(s.loadMessages(file), [summary, { role: "user", content: "recent" }]);
    // 原文仍在文件里
    assert.ok(readFileSync(file, "utf8").includes("old question"));
    // 第二次压缩后只剩第二段
    const summary2 = { role: "summary" as const, text: "SUM2", files: { read: [], modified: [] } };
    s.commitCompact(summary2, []);
    assert.deepEqual(s.loadMessages(file), [summary2]);
  });

  test("没有 writer 时 commitCompact 什么都不写", () => {
    s.commitCompact({ role: "summary", text: "S", files: { read: [], modified: [] } }, []);
    assert.equal(existsSync(dir), false);
  });

  test("分隔写上后后面一行失败：截回原长度，没有新的 compact 分隔，内存消息不变", () => {
    const messages: Message[] = [];
    s.pushMessage(messages, { role: "user", content: "old question" });
    s.pushMessage(messages, { role: "user", content: "recent" });
    const file = s.sessionFile()!;
    const before = readFileSync(file);
    const mem = structuredClone(messages);
    const past = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(file, past, past);
    const stamped = statSync(file).mtimeMs;
    const real = s.openSession(file);
    // 分隔先落盘，摘要那次追加故意失败
    s.bindSession({
      file,
      name: s.sessionName() ?? "",
      append(entry) {
        if ((entry as { type?: string }).type === "message") throw new Error("summary write failed");
        real.append(entry);
      },
      markCompact() {
        real.markCompact();
      },
      dropLast() {
        real.dropLast();
      },
    });
    const summary = { role: "summary" as const, text: "S", files: { read: [] as string[], modified: [] as string[] } };
    assert.throws(() => s.commitCompact(summary, [messages[1]!]), { message: "summary write failed" });
    assert.ok(statSync(file).mtimeMs > stamped);
    assert.deepEqual(readFileSync(file), before);
    assert.equal(lines(file).some((l) => JSON.parse(l).type === "compact"), false);
    assert.deepEqual(messages, mem);
    assert.deepEqual(s.loadMessages(file), mem);
  });

  test("空间只够分隔行、不够摘要时预检拒绝，文件字节一个都不变，内存消息不变", () => {
    const messages: Message[] = [];
    s.pushMessage(messages, { role: "user", content: "keep me" });
    const file = s.sessionFile()!;
    const head = readFileSync(file);
    // 分隔加补上的换行放得下，再加上摘要就超过 32MB
    const room = Buffer.byteLength(JSON.stringify({ type: "compact", createdAt: new Date().toISOString() }) + "\n") + 1;
    truncateSync(file, SESSION_MAX - room);
    const past = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(file, past, past);
    const stamped = statSync(file).mtimeMs;
    const mem = structuredClone(messages);
    const summary = { role: "summary" as const, text: "S", files: { read: [] as string[], modified: [] as string[] } };
    assert.throws(() => s.commitCompact(summary, []), { message: `session file exceeds ${SESSION_MAX} bytes` });
    assert.equal(statSync(file).mtimeMs, stamped);
    assert.equal(statSync(file).size, SESSION_MAX - room);
    assert.deepEqual(readSlice(file, head.length, 0), head);
    assert.equal(readSlice(file, 64, SESSION_MAX - room - 64).includes(Buffer.from("compact")), false);
    assert.deepEqual(messages, mem);
    assert.deepEqual(s.loadMessages(file), mem);
  });

  test("末尾不是换行、补上这一字节就会超限时预检拒绝，文件字节不变", () => {
    const messages: Message[] = [];
    s.pushMessage(messages, { role: "user", content: "keep me" });
    const file = s.sessionFile()!;
    const head = readFileSync(file);
    const summary = { role: "summary" as const, text: "S", files: { read: [] as string[], modified: [] as string[] } };
    const payload = plannedBytes(summary, []);
    // 不算补上的换行刚好到顶，算上就超。延长后最后一个字节是 0，不是换行
    truncateSync(file, SESSION_MAX - payload);
    const past = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(file, past, past);
    const stamped = statSync(file).mtimeMs;
    assert.throws(() => s.commitCompact(summary, []), { message: `session file exceeds ${SESSION_MAX} bytes` });
    assert.equal(statSync(file).mtimeMs, stamped);
    assert.equal(statSync(file).size, SESSION_MAX - payload);
    assert.deepEqual(readSlice(file, head.length, 0), head);
    assert.equal(readSlice(file, 1, SESSION_MAX - payload - 1)[0], 0);
  });
});

describe("恢复时修补（经 loadMessages 观察）", () => {
  const callA = { type: "toolCall", id: "a", name: "read", arguments: { path: "x" } };
  const callB = { type: "toolCall", id: "b", name: "bash", arguments: { command: "ls" } };
  const repaired = (id: string, name: string) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: "Error: missing tool result (session repaired)",
    isError: true,
  });

  test("缺失的 toolResult 在下一条 user 之前补上", () => {
    const file = writeSession("r1_0001.jsonl", [
      meta(),
      msg({ role: "user", content: "q" }),
      msg({ role: "assistant", content: [callA, callB], stopReason: "toolUse", usage: { input: 1, output: 1 } }),
      msg({ role: "toolResult", toolCallId: "a", toolName: "read", content: "ok", isError: false }),
      msg({ role: "user", content: "next" }),
    ]);
    const out = s.loadMessages(file);
    assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "toolResult", "toolResult", "user"]);
    assert.deepEqual(out[3], repaired("b", "bash"));
  });

  test("文件末尾还没配上结果的调用也补上", () => {
    const file = writeSession("r2_0002.jsonl", [
      meta(),
      msg({ role: "user", content: "q" }),
      msg({ role: "assistant", content: [callA], stopReason: "toolUse", usage: { input: 1, output: 1 } }),
    ]);
    assert.deepEqual(s.loadMessages(file).at(-1), repaired("a", "read"));
  });

  test("aborted 的 assistant 不补结果", () => {
    const file = writeSession("r3_0003.jsonl", [
      meta(),
      msg({ role: "user", content: "q" }),
      msg({ role: "assistant", content: [callA], stopReason: "aborted", usage: { input: 0, output: 0 } }),
      msg({ role: "user", content: "again" }),
    ]);
    assert.deepEqual(s.loadMessages(file).map((m) => m.role), ["user", "assistant", "user"]);
  });

  test("summary 与 skill 也是边界，前面没配上的调用在它们之前补", () => {
    const file = writeSession("r4_0004.jsonl", [
      meta(),
      msg({ role: "assistant", content: [callA], stopReason: "toolUse", usage: { input: 1, output: 1 } }),
      msg({ role: "summary", text: "S", files: { read: [], modified: [] } }),
      msg({ role: "assistant", content: [callB], stopReason: "toolUse", usage: { input: 1, output: 1 } }),
      msg({ role: "skill", name: "k", path: "/p", body: "B", args: "" }),
    ]);
    assert.deepEqual(s.loadMessages(file).map((m) => m.role), ["assistant", "toolResult", "summary", "assistant", "toolResult", "skill"]);
  });

  test("对不上调用的 toolResult 丢掉，重复的结果只留第一条", () => {
    const file = writeSession("r5_0005.jsonl", [
      meta(),
      msg({ role: "toolResult", toolCallId: "orphan", toolName: "read", content: "x", isError: false }),
      msg({ role: "assistant", content: [callA], stopReason: "toolUse", usage: { input: 1, output: 1 } }),
      msg({ role: "toolResult", toolCallId: "a", toolName: "read", content: "first", isError: false }),
      msg({ role: "toolResult", toolCallId: "a", toolName: "read", content: "dup", isError: false }),
    ]);
    const out = s.loadMessages(file);
    assert.deepEqual(out.map((m) => m.role), ["assistant", "toolResult"]);
    assert.equal((out[1] as any).content, "first");
  });

  test("坏行与形状不对的消息被丢掉，其余照读", () => {
    const file = writeSession("r6_0006.jsonl", [
      meta(),
      "not json at all",
      '{"no":"type"}',
      msg({ role: "user", content: [{ type: "image", data: "..." }] }),
      msg({ role: "user", content: 42 }),
      msg({ role: "assistant", content: [{ type: "weird" }], stopReason: "stop", usage: {} }),
      msg({ role: "assistant", content: "not an array" }),
      msg({ role: "summary", text: "   " }),
      msg({ role: "skill", name: "k", path: "/p", body: "" }),
      msg({ role: "toolResult" }),
      msg({ role: "martian", content: "?" }),
      msg({ role: "user", content: "survivor" }),
    ]);
    assert.deepEqual(s.loadMessages(file), [{ role: "user", content: "survivor" }]);
  });

  test("字段收拾：未知 stopReason 当 stop，用量非数字当 0，参数不是对象当空对象，缺的清单当空", () => {
    const file = writeSession("r7_0007.jsonl", [
      meta(),
      msg({
        role: "assistant",
        content: [{ type: "text", text: "t" }, { type: "toolCall", id: "c", name: "read", arguments: [1, 2] }],
        stopReason: "exploded",
        usage: { input: "many", output: 5 },
      }),
      msg({ role: "toolResult", toolCallId: "c", content: 123 }),
      msg({ role: "summary", text: "S", files: { read: ["ok", 3, ""], modified: "nope" } }),
      msg({ role: "skill", name: "k", path: "/p", body: "B" }),
    ]);
    assert.deepEqual(s.loadMessages(file), [
      {
        role: "assistant",
        content: [
          { type: "text", text: "t" },
          { type: "toolCall", id: "c", name: "read", arguments: {} },
        ],
        stopReason: "stop",
        usage: { input: 0, output: 5 },
      },
      { role: "toolResult", toolCallId: "c", toolName: "", content: "123", isError: false },
      { role: "summary", text: "S", files: { read: ["ok"], modified: [] } },
      { role: "skill", name: "k", path: "/p", body: "B", args: "" },
    ]);
  });

  test("CRLF 行尾也能读", () => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "crlf_0008.jsonl");
    writeFileSync(file, [meta(), msg({ role: "user", content: "win" })].map((r) => JSON.stringify(r)).join("\r\n") + "\r\n");
    assert.deepEqual(s.loadMessages(file), [{ role: "user", content: "win" }]);
  });
});

describe("路径与版本检查", () => {
  test("isSessionPath 只认当前 sessions 目录里的文件", () => {
    const inside = writeSession("in_0001.jsonl", [meta()]);
    assert.equal(s.isSessionPath(inside), true);
    assert.equal(s.isSessionPath(join(dir, "not-yet-created.jsonl")), true);
    assert.equal(s.isSessionPath(dir), false);
    assert.equal(s.isSessionPath(join(box.project, "x.jsonl")), false);
    assert.equal(s.isSessionPath(join(dir, "..", "..", "escape.jsonl")), false);
    assert.equal(s.isSessionPath("/etc/passwd"), false);
  });

  test("isSessionPath 按真实路径判断，指向外面的符号链接不算", () => {
    writeSession("in_0001.jsonl", [meta()]);
    const outside = join(box.root, "outside.jsonl");
    writeFileSync(outside, JSON.stringify(meta()) + "\n");
    const link = join(dir, "link_0002.jsonl");
    symlinkSync(outside, link);
    assert.equal(s.isSessionPath(link), false);
  });

  test("openSession 与 loadMessages 拒绝目录外的路径", () => {
    const outside = join(box.root, "o.jsonl");
    writeFileSync(outside, JSON.stringify(meta()) + "\n");
    assert.throws(() => s.openSession(outside), { message: "session path is outside this project" });
    assert.throws(() => s.loadMessages(outside), { message: "session path is outside this project" });
  });

  test("meta 版本比当前新时拒绝打开和读取", () => {
    const file = writeSession("new_0001.jsonl", [meta({ version: 2 }), msg({ role: "user", content: "x" })]);
    assert.throws(() => s.openSession(file), { message: "session format v2 is newer than this ti" });
    assert.throws(() => s.loadMessages(file), { message: "session format v2 is newer than this ti" });
  });

  test("没有 meta 或版本相同都能读", () => {
    const noMeta = writeSession("nometa_0001.jsonl", [msg({ role: "user", content: "x" })]);
    assert.deepEqual(s.loadMessages(noMeta), [{ role: "user", content: "x" }]);
  });
});

describe("openSession 与 bindSession", () => {
  test("显示名：meta.name 优先，否则取压缩后的首条用户输入，再否则取文件名", () => {
    const named = writeSession("n1_aaaa.jsonl", [meta({ name: "My Name" }), msg({ role: "user", content: "first" })]);
    assert.equal(s.openSession(named).name, "My Name");
    const unnamed = writeSession("n2_bbbb.jsonl", [
      meta(),
      msg({ role: "user", content: "before compact" }),
      { type: "compact" },
      msg({ role: "summary", text: "S", files: { read: [], modified: [] } }),
      msg({ role: "skill", name: "k", path: "/p", body: "B", args: "go" }),
    ]);
    assert.equal(s.openSession(unnamed).name, "/k go");
    const bare = writeSession("n3_cccc.jsonl", [meta()]);
    assert.equal(s.openSession(bare).name, "n3_cccc");
  });

  test("bind 之后追加进这份文件，不写新 meta", () => {
    const file = writeSession("bind_dddd.jsonl", [meta({ name: "B" }), msg({ role: "user", content: "old" })]);
    const messages = s.loadMessages(file);
    s.bindSession(s.openSession(file));
    assert.equal(s.sessionFile(), file);
    assert.equal(s.sessionName(), "B");
    s.pushMessage(messages, { role: "user", content: "new" });
    assert.equal(entries(file).filter((e) => e.type === "meta").length, 1);
    assert.deepEqual(s.loadMessages(file), [
      { role: "user", content: "old" },
      { role: "user", content: "new" },
    ]);
  });

  test("endSession 断开后下一条消息开新文件，旧文件留在磁盘", () => {
    s.pushMessage([], { role: "user", content: "first file" });
    const first = s.sessionFile()!;
    s.endSession();
    assert.equal(s.sessionFile(), undefined);
    s.pushMessage([], { role: "user", content: "second file" });
    assert.notEqual(s.sessionFile(), first);
    assert.ok(existsSync(first));
  });
});

describe("锁", () => {
  test("建档时占 .lock（写本进程 pid），endSession 放掉", () => {
    s.pushMessage([], { role: "user", content: "locked" });
    const file = s.sessionFile()!;
    assert.equal(readFileSync(file + ".lock", "utf8"), `${process.pid}\n`);
    s.endSession();
    assert.equal(existsSync(file + ".lock"), false);
  });

  test("另一个活着的进程握着锁时 bind 失败", () => {
    const file = writeSession("busy_eeee.jsonl", [meta()]);
    writeFileSync(file + ".lock", `${process.ppid}\n`);
    assert.throws(() => s.bindSession(s.openSession(file)), { message: "session is in use by another ti process" });
    assert.equal(s.sessionFile(), undefined);
  });

  test("锁的主人已经退出时抢过来", () => {
    const file = writeSession("stale_ffff.jsonl", [meta()]);
    writeFileSync(file + ".lock", `${deadPid()}\n`);
    s.bindSession(s.openSession(file));
    assert.equal(readFileSync(file + ".lock", "utf8"), `${process.pid}\n`);
  });

  test("锁文件内容坏了也当死锁抢", () => {
    const file = writeSession("junk_1111.jsonl", [meta()]);
    writeFileSync(file + ".lock", "garbage");
    s.bindSession(s.openSession(file));
    assert.equal(s.sessionFile(), file);
  });

  test("换档时先占新锁再放旧锁；新锁占不到时旧档仍在手里", () => {
    const a = writeSession("a_2222.jsonl", [meta()]);
    const b = writeSession("b_3333.jsonl", [meta()]);
    s.bindSession(s.openSession(a));
    writeFileSync(b + ".lock", `${process.ppid}\n`);
    assert.throws(() => s.bindSession(s.openSession(b)));
    assert.equal(s.sessionFile(), a);
    assert.ok(existsSync(a + ".lock"));
    rmSync(b + ".lock");
    s.bindSession(s.openSession(b));
    assert.equal(existsSync(a + ".lock"), false);
    assert.ok(existsSync(b + ".lock"));
  });
});

describe("renameSession", () => {
  test("没有 writer 时返回 undefined", () => {
    assert.equal(s.renameSession("x"), undefined);
  });

  test("换 slug 保留 hex，旧文件与旧锁消失，meta.name 更新", () => {
    const messages: Message[] = [];
    s.pushMessage(messages, { role: "user", content: "original title" });
    const prev = s.sessionFile()!;
    const hex = basename(prev).match(/_([0-9a-f]{4})\.jsonl$/)![1];
    const next = s.renameSession("New Name: v2\nignored")!;
    assert.equal(basename(next), `New-Name-v2_${hex}.jsonl`);
    assert.equal(s.sessionFile(), next);
    assert.equal(s.sessionName(), "New Name: v2");
    assert.equal(existsSync(prev), false);
    assert.equal(existsSync(prev + ".lock"), false);
    assert.equal(readFileSync(next + ".lock", "utf8"), `${process.pid}\n`);
    assert.equal(entries(next)[0].name, "New Name: v2");
    assert.equal(statSync(next).mode & 0o777, 0o600);
    // 之后的追加进新文件
    s.pushMessage(messages, { role: "user", content: "after rename" });
    assert.deepEqual(s.loadMessages(next), messages);
  });

  test("空名字不改，返回当前文件", () => {
    s.pushMessage([], { role: "user", content: "keep" });
    const file = s.sessionFile()!;
    assert.equal(s.renameSession("   "), file);
    assert.equal(s.sessionName(), "keep");
  });

  test("slug 不变时只改 meta.name", () => {
    s.pushMessage([], { role: "user", content: "same" });
    const file = s.sessionFile()!;
    assert.equal(s.renameSession("same"), file);
    assert.equal(entries(file)[0].name, "same");
  });

  test("目标文件已存在时另抽 hex，绝不覆盖", () => {
    s.pushMessage([], { role: "user", content: "mine" });
    const prev = s.sessionFile()!;
    const hex = basename(prev).match(/_([0-9a-f]{4})\.jsonl$/)![1];
    const taken = join(dir, `taken_${hex}.jsonl`);
    writeFileSync(taken, "precious\n");
    const next = s.renameSession("taken")!;
    assert.notEqual(next, taken);
    assert.match(basename(next), /^taken_[0-9a-f]{4}\.jsonl$/);
    assert.equal(readFileSync(taken, "utf8"), "precious\n");
    assert.equal(existsSync(prev), false);
  });
});

describe("listSessions", () => {
  test("没有目录时是空列表", () => {
    assert.deepEqual(s.listSessions(), []);
  });

  test("按 mtime 倒序，名字 meta.name > 首条输入 > 文件名，条数只算压缩后的消息", () => {
    const a = writeSession("a_0001.jsonl", [meta({ name: "Named A" }), msg({ role: "user", content: "x" })]);
    const b = writeSession("b_0002.jsonl", [
      meta(),
      msg({ role: "user", content: "old" }),
      { type: "compact" },
      msg({ role: "summary", text: "S", files: { read: [], modified: [] } }),
      msg({ role: "user", content: "first after compact\nline2" }),
    ]);
    const c = writeSession("c_0003.jsonl", [meta()]);
    writeFileSync(join(dir, "ignored.txt"), "x");
    mkdirSync(join(dir, "folder.jsonl"));
    const now = Date.now() / 1000;
    utimesSync(a, now - 300, now - 300);
    utimesSync(b, now - 100, now - 100);
    utimesSync(c, now - 200, now - 200);
    const list = s.listSessions();
    assert.deepEqual(
      list.map((i) => [basename(i.file), i.name, i.count]),
      [
        ["b_0002.jsonl", "first after compact", 2],
        ["c_0003.jsonl", "c_0003", 0],
        ["a_0001.jsonl", "Named A", 1],
      ],
    );
    assert.ok(list[0]!.mtime > list[1]!.mtime);
    assert.deepEqual(s.listSessions(2).map((i) => basename(i.file)), ["b_0002.jsonl", "c_0003.jsonl"]);
  });

  test("只列当前工作目录下的会话", () => {
    writeSession("here_0001.jsonl", [meta()]);
    const other = join(box.root, "other-project");
    mkdirSync(other);
    const cwd = process.cwd();
    process.chdir(other);
    try {
      assert.deepEqual(s.listSessions(), []);
    } finally {
      process.chdir(cwd);
    }
    assert.equal(s.listSessions().length, 1);
  });

  test("会话文件名都在 sessions 目录下", () => {
    s.pushMessage([], { role: "user", content: "listed" });
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".jsonl")).length, 1);
    assert.equal(s.listSessions()[0]!.name, "listed");
  });
});
