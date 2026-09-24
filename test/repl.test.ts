// cli/repl.ts：经导出的 repl() 配假 Tui 与假 fetch，跑斜杠命令、普通对话、skill 调用、压缩与恢复
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaletteLookup, SlashCommand, Tui } from "../src/cli/tui.ts";
import type { Message } from "../src/types.ts";
import { anthropicStream, fakeFetch, fakeProvider, isolate, openaiStream, plain, recordUI, type FakeFetch, type FakeReply } from "./helpers.ts";

const box = isolate();
const settingsFile = join(box.home, ".ti", "settings.json");
const baseSettings = {
  provider: "deepseek",
  providers: {
    deepseek: { apiKey: "d", model: "deepseek-v4-flash", models: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] },
    kimi: { apiKey: "k" },
  },
};
mkdirSync(join(box.home, ".ti"), { recursive: true });
writeFileSync(settingsFile, JSON.stringify(baseSettings));

const config = await import("../src/config/index.ts");
const { COMMANDS, commandNames, pickAndResume, repl } = await import("../src/cli/repl.ts");
const { loadSkills } = await import("../src/core/skills.ts");
const session = await import("../src/core/session.ts");
const { resetTrust } = await import("../src/core/compact.ts");

const skillsRoot = join(box.project, ".ti", "skills");

// 一个按脚本吐输入行、记下所有输出与调用的假 Tui
function fakeTui(input: string[], pickFn?: (title: string, choices: { value: unknown; label: string; current?: boolean }[]) => unknown) {
  const queue = [...input];
  const state = {
    said: [] as string[],
    busy: [] as boolean[],
    history: [] as string[][],
    footer: "",
    commands: [] as SlashCommand[],
    lookup: undefined as PaletteLookup | undefined,
    cleared: 0,
    picks: [] as { title: string; labels: string[] }[],
  };
  const tui: Tui = {
    write: (s) => state.said.push(plain(s)),
    writeln: (s) => state.said.push(plain(s)),
    clear: () => {
      state.cleared += 1;
    },
    pause() {},
    resume() {},
    readLine: async () => queue.shift() ?? null,
    close() {},
    setBusy: (b) => state.busy.push(b),
    setFooter: (s) => {
      state.footer = plain(s);
    },
    setCommands: (c) => {
      state.commands = c;
    },
    setLookup: (fn) => {
      state.lookup = fn;
    },
    onInterrupt() {},
    pick: (async (title: string, choices: { value: unknown; label: string }[]) => {
      state.picks.push({ title, labels: choices.map((c) => plain(c.label)) });
      return pickFn?.(title, choices);
    }) as Tui["pick"],
    ask: async () => undefined,
    addHistory: (lines) => state.history.push(lines),
  };
  return { tui, state };
}

let net: FakeFetch | undefined;

// 用给定的输入行跑一次 repl，直到输入耗尽或 /exit
async function run(
  lines: string[],
  opts: { messages?: Message[]; replies?: FakeReply[]; pick?: Parameters<typeof fakeTui>[1] } = {},
) {
  net?.restore();
  net = fakeFetch(opts.replies ?? []);
  const { tui, state } = fakeTui(lines, opts.pick);
  const rec = recordUI();
  const messages = opts.messages ?? [];
  await repl(messages, { systemPrompt: "SYS", ui: rec.ui }, loadSkills(commandNames()), tui);
  return { ...state, messages, rec, requests: net.requests };
}

// 一段纯文本回包
function reply(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): FakeReply {
  return { frames: openaiStream({ text: [text], finish: "stop", usage }) };
}

// 放一个项目级 skill
function putSkill(name: string, text: string): string {
  const dir = join(skillsRoot, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, text);
  return path;
}

// 一段超过 2 万 token 的历史，压缩时能切出前两条
function bigHistory(usage = { input: 9_000, output: 100 }): Message[] {
  const big = "a".repeat(40_000);
  return [
    { role: "user", content: big },
    { role: "assistant", content: [{ type: "text", text: big }], stopReason: "stop", usage: { input: 1, output: 1 } },
    { role: "user", content: big },
    { role: "assistant", content: [{ type: "text", text: big }], stopReason: "stop", usage },
  ];
}

beforeEach(() => {
  session.endSession();
  resetTrust();
  rmSync(join(box.project, ".ti"), { recursive: true, force: true });
  writeFileSync(settingsFile, JSON.stringify(baseSettings));
  config.reloadSettings();
  config.setProvider(config.resolveProvider("deepseek"));
});
afterEach(() => {
  net?.restore();
  net = undefined;
});

describe("命令表", () => {
  test("commandNames 是去掉斜杠的内置命令加 quit", () => {
    assert.deepEqual(commandNames(), [...COMMANDS.map((c) => c.name.slice(1)), "quit"]);
    assert.ok(commandNames().includes("help"));
    assert.ok(commandNames().every((n) => !n.startsWith("/")));
  });

  test("主屏命令列表是内置命令加可调用的 skill，skill 描述压成一行截到 60 字", async () => {
    putSkill("deploy", `---\ndescription: |\n  ship it\n  ${"x".repeat(100)}\n---\nbody\n`);
    putSkill("help", "---\ndescription: clash\n---\nbody\n");
    const r = await run([]);
    const names = r.commands.map((c) => c.name);
    assert.deepEqual(names.slice(0, COMMANDS.length), COMMANDS.map((c) => c.name));
    assert.deepEqual(names.slice(COMMANDS.length), ["/deploy"]);
    assert.equal(r.commands.at(-1)!.hint, `ship it ${"x".repeat(52)}`);
  });

  test("/model、/provider 的二级列表：当前项标 current，可按词过滤，其他输入不接管", async () => {
    const r = await run([]);
    const lookup = r.lookup!;
    assert.deepEqual(
      lookup("/model")!.map((i) => [i.name, i.current]),
      [
        ["/model deepseek-v4-flash", true],
        ["/model deepseek-v4-pro", false],
      ],
    );
    assert.deepEqual(lookup("/model pro")!.map((i) => i.name), ["/model deepseek-v4-pro"]);
    assert.deepEqual(lookup("/model zzz"), []);
    assert.deepEqual(
      lookup("/provider")!.map((i) => [i.name, i.label, i.current]),
      [
        ["/provider deepseek", "DeepSeek", true],
        ["/provider kimi", "Kimi", false],
      ],
    );
    assert.equal(lookup("/help"), null);
    assert.equal(lookup("/"), null);
  });
});

describe("内置命令", () => {
  test("/help 列出命令和快捷键", async () => {
    const r = await run(["/help"]);
    for (const c of COMMANDS) assert.ok(r.said.some((l) => l.startsWith(c.name) && l.includes(c.hint)), c.name);
    assert.ok(r.said.includes("keys"));
    assert.ok(r.said.some((l) => l.includes("shift+enter") && l.includes("newline (or \\ then enter)")));
  });

  test("/cost 初始为 0", async () => {
    const r = await run(["/cost"]);
    assert.deepEqual(r.said, ["session  0 in · 0 out · 0 calls"]);
  });

  test("不认识的命令只提示，不发给模型", async () => {
    const r = await run(["/nope arg"]);
    assert.deepEqual(r.said, ["unknown command /nope  ·  type / for the list"]);
    assert.equal(r.requests.length, 0);
    assert.deepEqual(r.messages, []);
  });

  test("/exit 与 /quit 之后的输入不再处理", async () => {
    for (const cmd of ["/exit", "/quit"]) {
      const r = await run([cmd, "hello"]);
      assert.equal(r.requests.length, 0);
      assert.deepEqual(r.messages, []);
    }
  });

  test("内置命令不设 busy，空行什么都不做", async () => {
    const r = await run(["/help", "", "   "]);
    assert.deepEqual(r.busy, [false, false, false]);
    assert.equal(r.requests.length, 0);
  });

  test("/model <id> 切到已写入的模型并写回 settings；不认识的只提示", async () => {
    const r = await run(["/model deepseek-v4-pro", "/model made-up"]);
    assert.deepEqual(r.said, ["model → deepseek-v4-pro", "unknown model made-up  ·  /setup to add"]);
    assert.equal(config.getProvider().model, "deepseek-v4-pro");
    assert.equal(JSON.parse(readFileSync(settingsFile, "utf8")).providers.deepseek.model, "deepseek-v4-pro");
    assert.match(r.footer, /^deepseek:deepseek-v4-pro/);
  });

  test("/model 与 /provider 不带参数时在主屏里列出可选项", async () => {
    const r = await run(["/model", "/provider"]);
    assert.deepEqual(r.said, ["models: deepseek-v4-flash, deepseek-v4-pro", "providers: deepseek, kimi"]);
  });

  test("/provider <name> 整套切换并记为当前；不能用的报错", async () => {
    const r = await run(["/provider kimi", "/provider nope"]);
    assert.equal(r.said[0], "provider → kimi:kimi-k3");
    assert.match(r.said[1]!, /^error: unknown provider "nope"/);
    assert.equal(config.getProvider().name, "kimi");
    assert.equal(config.getProvider().protocol, "anthropic");
    assert.equal(JSON.parse(readFileSync(settingsFile, "utf8")).provider, "kimi");
  });

  test("/rename：还没建档时提示；有会话后改名并能查看", async () => {
    const r = await run(["/rename", "/rename early", "first question", "/rename Better Name", "/rename"], {
      replies: [reply("answer")],
    });
    assert.deepEqual(r.said.filter((l) => l !== ""), ["no session yet", "no session yet", "renamed → Better Name", "session  Better Name"]);
    assert.match(session.sessionFile()!, /Better-Name_[0-9a-f]{4}\.jsonl$/);
  });

  test("/clear 清空内存、断开会话、清屏，用量归零", async () => {
    const r = await run(["hi", "/clear", "/cost"], { replies: [reply("yo", { prompt_tokens: 10, completion_tokens: 2 })] });
    assert.deepEqual(r.messages, []);
    assert.equal(session.sessionFile(), undefined);
    assert.equal(r.cleared, 1);
    assert.ok(r.said.includes("(context cleared)"));
    assert.equal(r.said.at(-1), "session  0 in · 0 out · 0 calls");
  });

  test("/skills：没有时给出放置位置", async () => {
    const r = await run(["/skills"]);
    assert.deepEqual(r.said, ["no skills · put SKILL.md under .ti/skills/<name>/ or ~/.ti/skills/<name>/"]);
  });

  test("/skills：列出名字、来源、状态和警告", async () => {
    putSkill("visible", "---\ndescription: shown to model\n---\nbody\n");
    putSkill("secret", "---\ndescription: manual only\ndisable-model-invocation: true\n---\nbody\n");
    putSkill("help", "---\ndescription: clashes\n---\nbody\n");
    putSkill("broken", "---\nname: broken\n---\nbody\n");
    const r = await run(["/skills"]);
    const row = (name: string) => r.said.find((l) => l.startsWith(name + " "))!;
    assert.match(row("help"), /^help\s+project\s+\(no command\) clashes$/);
    assert.match(row("secret"), /^secret\s+project\s+\(hidden\) manual only$/);
    assert.match(row("visible"), /^visible\s+project\s+shown to model$/);
    const warnAt = r.said.indexOf("warnings");
    assert.ok(warnAt > 0);
    assert.ok(r.said.slice(warnAt).some((l) => l.includes("description is required")));
    assert.ok(r.said.slice(warnAt).some((l) => l.includes('skill "help" is shadowed by the /help command')));
  });
});

describe("对话", () => {
  test("普通输入：trim 后发给模型，设 busy，底栏记下这一轮与累计用量", async () => {
    const r = await run(["  hello  "], { replies: [reply("hi there", { prompt_tokens: 1200, completion_tokens: 34 })] });
    assert.deepEqual(r.messages.map((m) => m.role), ["user", "assistant"]);
    assert.deepEqual(r.messages[0], { role: "user", content: "hello" });
    assert.deepEqual(r.requests[0]!.body.messages.at(-1), { role: "user", content: "hello" });
    assert.deepEqual(r.busy, [true, false]);
    assert.equal(r.rec.text(), "hi there");
    assert.match(r.footer, /turn 1,200↑ 34↓/);
    assert.match(r.footer, /session 1,200↑ 34↓/);
  });

  test("多行输入依次处理，第二轮请求带上第一轮历史；/cost 累计", async () => {
    const r = await run(["one", "two", "/cost"], {
      replies: [reply("r1", { prompt_tokens: 10, completion_tokens: 1 }), reply("r2", { prompt_tokens: 20, completion_tokens: 2 })],
    });
    assert.deepEqual(
      r.requests[1]!.body.messages.slice(1).map((m: any) => [m.role, m.content]),
      [
        ["user", "one"],
        ["assistant", "r1"],
        ["user", "two"],
      ],
    );
    assert.equal(r.said.at(-1), "session  30 in · 3 out · 2 calls · last turn 20 in / 2 out");
  });

  test("请求失败：撤回这句（内存与文件），报错", async () => {
    const r = await run(["doomed"], { replies: [{ status: 500, body: "server down" }] });
    assert.deepEqual(r.messages, []);
    assert.ok(r.said.includes("error: API error 500: server down"));
    assert.deepEqual(session.loadMessages(session.sessionFile()!), []);
  });

  test("流中途抛错：半截助手和用户这句都留下", async () => {
    config.setProvider(fakeProvider("anthropic"));
    const frames = anthropicStream({ text: ["半截回复"] });
    frames.pop();
    frames.push(`data: ${JSON.stringify({ type: "error", error: { message: "Overloaded" } })}\n\n`);
    const r = await run(["keep me"], { replies: [{ frames }] });
    assert.deepEqual(r.messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal((r.messages[0] as any).content, "keep me");
    assert.equal((r.messages[1] as any).stopReason, "incomplete");
    assert.deepEqual((r.messages[1] as any).content, [{ type: "text", text: "半截回复" }]);
    assert.ok(r.said.includes("error: API stream error: Overloaded"));
    assert.deepEqual(session.loadMessages(session.sessionFile()!), r.messages);
  });

  test("会话落盘：对话后文件里能读回同样的消息", async () => {
    const r = await run(["persist me"], { replies: [reply("saved")] });
    assert.deepEqual(session.loadMessages(session.sessionFile()!), r.messages);
  });
});

describe("skill 调用", () => {
  test("/名字 参数：全文进这一轮，请求里是 <skill> 块加参数，会话以 /名字 命名", async () => {
    const path = putSkill("review", "---\ndescription: review code\n---\n# Review\n\nLook closely.\n");
    const r = await run(["/review src/a.ts"], { replies: [reply("reviewed")] });
    assert.deepEqual(r.messages[0], { role: "skill", name: "review", path, body: "# Review\n\nLook closely.", args: "src/a.ts" });
    const sent: string = r.requests[0]!.body.messages[1].content;
    assert.ok(sent.startsWith(`<skill name="review" location="${path}">\nReferences are relative to ${join(skillsRoot, "review")}.\n\n# Review`));
    assert.ok(sent.endsWith("</skill>\n\nsrc/a.ts"));
    assert.deepEqual(r.busy, [true, false]);
    assert.match(session.sessionFile()!, /review-src-a\.ts_[0-9a-f]{4}\.jsonl$/);
  });

  test("没有参数时只发 <skill> 块", async () => {
    putSkill("lint", "---\ndescription: lint\n---\nRun lint.\n");
    const r = await run(["/lint"], { replies: [reply("ok")] });
    assert.equal((r.messages[0] as any).args, "");
    assert.ok(r.requests[0]!.body.messages[1].content.endsWith("Run lint.\n</skill>"));
  });

  test("skill 没有正文时报错，不发请求", async () => {
    putSkill("empty", "---\ndescription: nothing inside\n---\n\n");
    const r = await run(["/empty"]);
    assert.deepEqual(r.said, ["error: /empty: skill file has no instructions"]);
    assert.equal(r.requests.length, 0);
  });

  test("与内置命令同名时内置命令优先", async () => {
    putSkill("help", "---\ndescription: shadowed\n---\nbody\n");
    const r = await run(["/help"]);
    assert.equal(r.requests.length, 0);
    assert.ok(r.said.includes("keys"));
  });
});

describe("压缩", () => {
  // 当前厂家去掉窗口：不自动压，手动压缩保留 2 万 token
  beforeEach(() => config.setProvider({ ...config.resolveProvider("deepseek"), contextWindow: undefined }));

  test("/compact 没东西可压时只提示", async () => {
    const r = await run(["/compact"], { messages: [{ role: "user", content: "short" }] });
    assert.deepEqual(r.said, ["nothing to compact"]);
    assert.deepEqual(r.busy, [true, false]);
  });

  test("/compact 成功：屏幕一行 compacted · A → B tokens，/cost 结转被压掉的用量", async () => {
    // 先 /clear 一次，把前面测试留下的结转与上一轮用量清零
    await run(["/clear"]);
    const r = await run(["/compact", "/cost"], {
      messages: bigHistory(),
      replies: [reply("## Goal\nsummary", { prompt_tokens: 50, completion_tokens: 5 })],
    });
    assert.match(r.said[0]!, /^compacted · 9,100 → [\d,]+ tokens$/);
    assert.equal(r.messages[0]!.role, "summary");
    assert.equal(r.messages.length, 3);
    // 保留段的 9000 入 100 出，加上结转的被压掉那条 1 入 1 出、摘要请求 50 入 5 出
    assert.equal(r.said[1], "session  9,051 in · 106 out · 1 calls");
  });

  test("/compact 请求失败时报错", async () => {
    const r = await run(["/compact"], { messages: bigHistory(), replies: [{ status: 503, body: "busy" }] });
    assert.deepEqual(r.said, ["error: API error 503: busy"]);
    assert.equal(r.messages.length, 4);
  });

  test("超过触发线时先自动压再发这一句", async () => {
    config.setProvider({ ...config.resolveProvider("deepseek"), contextWindow: 10_000 });
    const r = await run(["next question"], { messages: bigHistory(), replies: [reply("## Goal\nauto"), reply("answer")] });
    assert.match(r.said[0]!, /^auto compacted · 9,100 → [\d,]+ tokens$/);
    assert.deepEqual(r.messages.map((m) => m.role), ["summary", "user", "assistant", "user", "assistant"]);
    // 摘要请求在前，这一句在压缩之后才进历史
    assert.ok(!JSON.stringify(r.requests[0]!.body).includes("next question"));
    assert.deepEqual(r.requests[1]!.body.messages.at(-1), { role: "user", content: "next question" });
  });

  test("自动压缩失败时提示一句，照原样发出", async () => {
    config.setProvider({ ...config.resolveProvider("deepseek"), contextWindow: 10_000 });
    const r = await run(["go on"], { messages: bigHistory(), replies: [{ status: 500, body: "no" }, reply("fine")] });
    assert.equal(r.said[0], "compact skipped: API error 500: no");
    assert.equal(r.messages.length, 6);
  });

  test("上下文超限：压一次再重试这一轮", async () => {
    const r = await run(["overflowing"], {
      messages: bigHistory(),
      replies: [{ status: 400, body: "This model's maximum context length is 8192 tokens" }, reply("## Goal\nretry"), reply("recovered")],
    });
    assert.equal(r.said[0], "context overflow · compacting and retrying");
    assert.match(r.said[1]!, /^compacted · [\d,]+ → [\d,]+ tokens$/);
    assert.equal(r.requests.length, 3);
    assert.equal(r.messages[0]!.role, "summary");
    assert.deepEqual(r.messages.at(-1), {
      role: "assistant",
      content: [{ type: "text", text: "recovered" }],
      stopReason: "stop",
      usage: { input: 0, output: 0 },
    });
  });

  test("上下文超限且压缩失败：撤回这句并报错", async () => {
    const r = await run(["overflowing"], {
      messages: bigHistory(),
      replies: [{ status: 400, body: "prompt is too long" }, { status: 500, body: "nope" }],
    });
    assert.ok(r.said.includes("error: API error 500: nope"));
    assert.equal(r.messages.length, 4);
    assert.equal(r.messages.at(-1)!.role, "assistant");
  });
});

describe("恢复会话", () => {
  // 在当前目录写一份会话：普通输入、skill、摘要、被打断的回复
  function writeOld(): string {
    const dir = join(box.project, ".ti", "sessions");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "old-talk_abcd.jsonl");
    const rows = [
      { type: "meta", version: 1, cwd: box.project, createdAt: new Date().toISOString(), name: "" },
      { type: "message", role: "summary", text: "S", files: { read: [], modified: [] } },
      { type: "message", role: "user", content: "old talk" },
      { type: "message", role: "assistant", content: [{ type: "text", text: "old reply" }], stopReason: "stop", usage: { input: 5, output: 5 } },
      { type: "message", role: "skill", name: "k", path: "/p/SKILL.md", body: "B", args: "arg" },
      { type: "message", role: "assistant", content: [{ type: "text", text: "cut" }], stopReason: "aborted", usage: { input: 0, output: 0 } },
    ];
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return file;
  }

  test("/resume 选中后就地换内存、接上文件、重画历史、回灌 ↑ 历史", async () => {
    const file = writeOld();
    const messages: Message[] = [{ role: "user", content: "will be replaced" }];
    const r = await run(["/resume"], { messages, pick: (_t, choices) => choices[0]!.value });
    assert.equal(r.picks[0]!.title, "Resume");
    assert.match(r.picks[0]!.labels[0]!, /^old talk  ·  5 msgs  ·  /);
    assert.equal(r.messages, messages);
    assert.deepEqual(r.messages.map((m) => m.role), ["summary", "user", "assistant", "skill", "assistant"]);
    assert.equal(session.sessionFile(), file);
    assert.equal(r.cleared, 1);
    assert.deepEqual(r.history, [["old talk", "/k arg"]]);
    assert.ok(r.said.includes("[compacted summary]"));
    assert.ok(r.said.includes("❯ /k arg"));
    assert.equal(r.said.at(-1), "resumed 5 messages");
  });

  test("恢复后新的一句接在原文件后面", async () => {
    const file = writeOld();
    await run(["/resume", "follow up"], { pick: (_t, c) => c[0]!.value, replies: [reply("ok")] });
    const loaded = session.loadMessages(file);
    assert.deepEqual(loaded.slice(-2).map((m) => m.role), ["user", "assistant"]);
    assert.deepEqual(loaded.at(-2), { role: "user", content: "follow up" });
  });

  test("没有会话时提示；取消选择时什么都不动", async () => {
    const none = await run(["/resume"]);
    assert.deepEqual(none.said, ["no sessions in this directory"]);
    writeOld();
    const messages: Message[] = [{ role: "user", content: "keep" }];
    const cancel = await run(["/resume"], { messages, pick: () => undefined });
    assert.deepEqual(cancel.said, []);
    assert.deepEqual(cancel.messages, [{ role: "user", content: "keep" }]);
    assert.equal(session.sessionFile(), undefined);
  });

  test("选中当前这份时提示已经在上面", async () => {
    await run(["start here"], { replies: [reply("ok")] });
    const current = session.sessionFile()!;
    const r = await run(["/resume"], { pick: (_t, c) => c.find((x) => x.value === current)!.value });
    assert.deepEqual(r.said, ["already on this session"]);
  });

  test("pickAndResume 在管道里只打印列表，当新开", { skip: !!(process.stdin.isTTY && process.stdout.isTTY) }, async () => {
    writeOld();
    const said: string[] = [];
    const messages: Message[] = [];
    assert.equal(await pickAndResume(messages, (s) => said.push(plain(s))), false);
    assert.equal(said.length, 1);
    assert.match(said[0]!, /^old talk  ·  5 msgs  ·  /);
    assert.deepEqual(messages, []);
  });
});
