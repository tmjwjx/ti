// core/compact.ts：估算、阈值、切点、用量可信标记，以及经假 fetch 跑完整的 runCompact
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, Message, ToolCall } from "../src/types.ts";
import { fakeFetch, fakeProvider, isolate, openaiStream, type FakeFetch } from "./helpers.ts";

isolate();
const { setProvider } = await import("../src/config/index.ts");
const compact = await import("../src/core/compact.ts");
const session = await import("../src/core/session.ts");
const { contextTokens, distrustUsage, estimateText, estimateTokens, keepBudget, planCut, resetTrust, runCompact, shouldAutoCompact, triggerAt } =
  compact;

// 指定 token 数的纯 ASCII 文本（四字一 token）
function tokens(n: number, ch = "a"): string {
  return ch.repeat(n * 4);
}

// 一条 assistant，可带文字、工具调用和用量
function asst(parts: (string | ToolCall)[], usage = { input: 0, output: 0 }, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: parts.map((p) => (typeof p === "string" ? { type: "text" as const, text: p } : p)),
    stopReason,
    usage,
  };
}

// 一个工具调用块
function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

// 一条工具结果
function result(id: string, content: string, isError = false): Message {
  return { role: "toolResult", toolCallId: id, toolName: "t", content, isError };
}

describe("estimateText 与 estimateTokens", () => {
  test("ASCII 四字一 token，向上取整", () => {
    assert.equal(estimateText(""), 0);
    assert.equal(estimateText("abcd"), 1);
    assert.equal(estimateText("abcde"), 2);
    assert.equal(estimateText(tokens(100)), 100);
  });

  test("CJK 一字一 token，与 ASCII 分开算", () => {
    assert.equal(estimateText("你好"), 2);
    assert.equal(estimateText("你好ab"), 3);
    assert.equal(estimateText("日本語テキスト"), 7);
  });

  test("各角色的估算口径", () => {
    assert.equal(estimateTokens({ role: "user", content: tokens(3) }), 3);
    assert.equal(estimateTokens({ role: "user", content: [{ type: "text", text: tokens(2) }, { type: "text", text: tokens(2) }] }), 4);
    assert.equal(estimateTokens(result("x", tokens(5))), 5);
    assert.equal(estimateTokens({ role: "skill", name: "n", path: "/p", body: tokens(6), args: tokens(1) }), 7);
    assert.equal(estimateTokens({ role: "summary", text: tokens(2), files: { read: ["abcd"], modified: ["efgh"] } }), 4);
    // 调用按名字加 JSON 参数估
    assert.equal(estimateTokens(asst(["abcd", call("c", "read", {})])), 1 + 1 + 1);
  });
});

describe("triggerAt 与 keepBudget", () => {
  test("与实现文档里的对照表一致", () => {
    const table: [number | undefined, number | undefined, number][] = [
      [128_000, 102_400, 20_480],
      [200_000, 160_000, 32_000],
      [1_000_000, 200_000, 40_000],
      [undefined, undefined, 20_000],
    ];
    for (const [window, trigger, keep] of table) {
      assert.equal(triggerAt(window), trigger, `trigger ${window}`);
      assert.equal(keepBudget(window), keep, `keep ${window}`);
    }
  });

  test("小窗口：保留量不低于 20000；触发线按 80% 取整", () => {
    assert.equal(keepBudget(50_000), 20_000);
    assert.equal(triggerAt(50_001), 40_000);
    assert.equal(triggerAt(0), undefined);
  });
});

describe("planCut", () => {
  test("全都放得下就没有可压的", () => {
    assert.equal(planCut([{ role: "user", content: "a" }, asst(["b"])], 1000), undefined);
  });

  test("落在 toolResult 上时往前退到发起调用的 assistant", () => {
    const msgs: Message[] = [
      { role: "user", content: tokens(100) },
      asst([call("c1", "read", {}), call("c2", "read", {})]),
      result("c1", tokens(100)),
      result("c2", tokens(100)),
      asst(["done"]),
    ];
    const cut = planCut(msgs, 150);
    assert.equal(cut, 1);
    assert.equal(msgs[cut!]!.role, "assistant");
  });

  test("任何保留量下切点都不会是 toolResult", () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: "user", content: tokens(30) });
      msgs.push(asst([call(`c${i}`, "bash", {})]));
      msgs.push(result(`c${i}`, tokens(50)));
      msgs.push(asst([tokens(10)]));
    }
    for (let keep = 1; keep < 600; keep += 7) {
      const cut = planCut(msgs, keep);
      if (cut !== undefined) assert.notEqual(msgs[cut]!.role, "toolResult", `keep=${keep}`);
    }
  });

  test("切点会退到 0 时当作没有可压的", () => {
    const msgs: Message[] = [asst([call("c", "read", {})]), result("c", tokens(100))];
    assert.equal(planCut(msgs, 50), undefined);
  });
});

describe("contextTokens 与用量可信标记", () => {
  beforeEach(() => resetTrust());

  test("没有 assistant 用量就是 0", () => {
    assert.equal(contextTokens([{ role: "user", content: tokens(100) }]), 0);
  });

  test("最后一条有用量的 assistant 的 input+output，加上它之后内容的估算", () => {
    const msgs: Message[] = [{ role: "user", content: "q" }, asst([call("c", "read", {})], { input: 1000, output: 50 }), result("c", tokens(20))];
    assert.equal(contextTokens(msgs), 1070);
  });

  test("用量为 0/0 的 assistant（被打断）跳过，往前找", () => {
    const msgs: Message[] = [
      asst(["a"], { input: 500, output: 10 }),
      { role: "user", content: tokens(5) },
      asst(["half"], { input: 0, output: 0 }, "aborted"),
    ];
    assert.equal(contextTokens(msgs), 510 + 5 + 1);
  });

  test("distrustUsage 之后旧用量不算；之后新来的 assistant 照算；resetTrust 恢复", () => {
    const msgs: Message[] = [asst(["a"], { input: 900, output: 100 })];
    distrustUsage(msgs);
    assert.equal(contextTokens(msgs), 0);
    msgs.push({ role: "user", content: "q" });
    msgs.push(asst(["b"], { input: 1200, output: 30 }));
    assert.equal(contextTokens(msgs), 1230);
    msgs.pop();
    assert.equal(contextTokens(msgs), 0);
    resetTrust();
    assert.equal(contextTokens(msgs), 1000 + 1);
  });

  test("shouldAutoCompact：没有窗口不压；超过触发线才压", () => {
    const msgs: Message[] = [asst(["a"], { input: 102_400, output: 0 })];
    assert.equal(shouldAutoCompact(msgs, undefined), false);
    assert.equal(shouldAutoCompact(msgs, 128_000), false);
    msgs[0] = asst(["a"], { input: 102_401, output: 0 });
    assert.equal(shouldAutoCompact(msgs, 128_000), true);
    assert.equal(shouldAutoCompact([{ role: "user", content: tokens(200_000) }], 128_000), false);
  });
});

describe("runCompact", () => {
  let net: FakeFetch | undefined;
  beforeEach(() => {
    resetTrust();
    session.endSession();
    setProvider(fakeProvider("openai"));
  });
  afterEach(() => {
    net?.restore();
    net = undefined;
  });

  // 一段会被压掉的前文加两条各 10000 token 的保留段（无窗口时保留 20000）
  function history(): Message[] {
    return [
      { role: "user", content: "please fix" },
      asst(["sure", call("c1", "read", { path: "a.ts" }), call("c2", "read", { path: "b.ts" }), call("c5", "read", { path: "d.ts" })], { input: 100, output: 10 }),
      result("c1", "x".repeat(2500)),
      result("c2", "Error: ENOENT", true),
      result("c5", "d body"),
      asst([call("c3", "write", { path: "a.ts", content: "hi" }), call("c4", "edit", { path: "c.ts", edits: [] })], { input: 200, output: 20 }),
      result("c3", "wrote"),
      result("c4", "applied"),
      asst([call("c6", "bash", { command: "cat e.ts" })], { input: 300, output: 30 }),
      result("c6", ""),
      { role: "skill", name: "review", path: "/s/review/SKILL.md", body: "Do review", args: "src" },
      asst(["done"], { input: 400, output: 40 }),
      { role: "user", content: tokens(10_000) },
      asst([tokens(10_000)], { input: 25_000, output: 10_000 }),
    ];
  }

  // 一段正常说完的摘要回包
  function summaryReply(text = "## Goal\nfix it\n") {
    return { frames: openaiStream({ text: [text], finish: "stop", usage: { prompt_tokens: 7, completion_tokens: 3 } }) };
  }

  test("请求用 pi 的摘要 system prompt、首次指令，不带工具", async () => {
    net = fakeFetch([summaryReply()]);
    const r = await runCompact(history());
    assert.equal(r.ok, true);
    const body = net.requests[0]!.body;
    assert.equal("tools" in body, false);
    assert.equal(body.messages.length, 2);
    assert.ok(body.messages[0].content.startsWith("You are a context summarization assistant."));
    assert.ok(body.messages[0].content.includes("Do NOT continue the conversation."));
    const user: string = body.messages[1].content;
    assert.ok(user.startsWith("<conversation>\n"));
    assert.ok(user.includes("\n</conversation>\n\nThe messages above are a conversation to summarize."));
    assert.ok(user.endsWith("Keep each section concise. Preserve exact file paths, function names, and error messages."));
    assert.ok(!user.includes("<previous-summary>"));
  });

  test("对话序列化格式", async () => {
    net = fakeFetch([summaryReply()]);
    await runCompact(history());
    const user: string = net.requests[0]!.body.messages[1].content;
    const conv = user.slice("<conversation>\n".length, user.indexOf("\n</conversation>"));
    const clipped = `${"x".repeat(2000)}\n\n[... 500 more characters truncated]`;
    assert.equal(
      conv,
      [
        "[User]: please fix",
        "[Assistant]: sure",
        '[Assistant tool calls]: read(path="a.ts"); read(path="b.ts"); read(path="d.ts")',
        `[Tool result]: ${clipped}`,
        "[Tool result]: Error: ENOENT",
        "[Tool result]: d body",
        '[Assistant tool calls]: write(path="a.ts", content="hi"); edit(path="c.ts", edits=[])',
        "[Tool result]: wrote",
        "[Tool result]: applied",
        '[Assistant tool calls]: bash(command="cat e.ts")',
        "[User]: /review src",
        "[Skill review]: Do review",
        "[Assistant]: done",
      ].join("\n\n"),
    );
  });

  test("成功：内存换成摘要 + 保留段，文件清单只算成功的调用且改过的优先", async () => {
    net = fakeFetch([summaryReply("  ## Goal\nfix it  \n")]);
    const msgs = history();
    const kept = msgs.slice(-2);
    const r = await runCompact(msgs);
    assert.equal(r.ok, true);
    assert.equal(msgs.length, 3);
    assert.deepEqual(msgs[0], { role: "summary", text: "## Goal\nfix it", files: { read: ["d.ts"], modified: ["a.ts", "c.ts"] } });
    assert.equal(msgs[1], kept[0]);
    assert.equal(msgs[2], kept[1]);
    if (r.ok) {
      // 被压掉的 assistant 用量加摘要请求自己的用量
      assert.deepEqual(r.carried, { input: 100 + 200 + 300 + 400 + 7, output: 10 + 20 + 30 + 40 + 3 });
      assert.equal(r.before, 35_000 + 0);
      assert.ok(r.after < r.before);
    }
    // 压缩后保留段里的旧用量不再可信
    assert.equal(contextTokens(msgs), 0);
  });

  test("有旧摘要时放进 <previous-summary> 用合并指令，文件清单与旧的合并", async () => {
    net = fakeFetch([summaryReply("merged")]);
    const msgs: Message[] = [
      { role: "summary", text: "OLD SUMMARY", files: { read: ["r.ts", "keep.ts"], modified: ["m.ts"] } },
      { role: "user", content: "more" },
      asst([call("w", "write", { path: "r.ts", content: "" }), call("x", "read", { path: "n.ts" })]),
      result("w", "ok"),
      result("x", "ok"),
      { role: "user", content: tokens(10_000) },
      asst([tokens(10_000)]),
    ];
    const r = await runCompact(msgs);
    assert.equal(r.ok, true);
    const user: string = net.requests[0]!.body.messages[1].content;
    assert.ok(user.includes("\n</conversation>\n\n<previous-summary>\nOLD SUMMARY\n</previous-summary>\n\nThe messages above are NEW conversation messages"));
    assert.ok(!user.includes("[User]: The conversation history"));
    assert.ok(!user.includes("OLD SUMMARY\n\n[User]"));
    assert.ok(user.startsWith("<conversation>\n[User]: more"));
    assert.deepEqual(msgs[0], { role: "summary", text: "merged", files: { read: ["keep.ts", "n.ts"], modified: ["m.ts", "r.ts"] } });
  });

  test("全部放得下：empty，不发请求", async () => {
    net = fakeFetch([]);
    const msgs: Message[] = [{ role: "user", content: "hi" }, asst(["yo"])];
    assert.deepEqual(await runCompact(msgs), { ok: false, aborted: false, empty: true, error: "nothing to compact" });
    assert.equal(net.requests.length, 0);
  });

  test("可压的只有旧摘要：empty", async () => {
    net = fakeFetch([]);
    const msgs: Message[] = [
      { role: "summary", text: "S", files: { read: [], modified: [] } },
      { role: "user", content: tokens(10_000) },
      asst([tokens(10_000)]),
    ];
    const r = await runCompact(msgs);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.empty, true);
    assert.equal(net.requests.length, 0);
  });

  test("请求失败：返回错误，消息原样不动", async () => {
    net = fakeFetch([{ status: 500, body: "boom" }]);
    const msgs = history();
    const copy = structuredClone(msgs);
    assert.deepEqual(await runCompact(msgs), { ok: false, aborted: false, empty: false, error: "API error 500: boom" });
    assert.deepEqual(msgs, copy);
  });

  test("被打断：aborted，消息原样不动", async () => {
    net = fakeFetch([summaryReply()]);
    const ac = new AbortController();
    ac.abort();
    const msgs = history();
    const copy = structuredClone(msgs);
    assert.deepEqual(await runCompact(msgs, ac.signal), { ok: false, aborted: true, empty: false, error: "aborted" });
    assert.deepEqual(msgs, copy);
  });

  test("流中途被打断：aborted，消息原样不动", async () => {
    const ac = new AbortController();
    net = fakeFetch([{ frames: openaiStream({ text: ["## Go"], done: false }), hang: () => ac.abort() }]);
    const msgs = history();
    const copy = structuredClone(msgs);
    const r = await runCompact(msgs, ac.signal);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.aborted, true);
    assert.deepEqual(msgs, copy);
  });

  test("模型没给出可用文字或没说完：summary was empty or incomplete", async () => {
    for (const frames of [
      openaiStream({ text: ["   "], finish: "stop" }),
      openaiStream({ text: ["cut off"], finish: "length" }),
      openaiStream({ text: ["no finish"] }),
      openaiStream({ text: ["x"], calls: [{ id: "c", name: "read", args: ["{}"] }], finish: "tool_calls" }),
    ]) {
      net = fakeFetch([{ frames }]);
      const msgs = history();
      const copy = structuredClone(msgs);
      assert.deepEqual(await runCompact(msgs), { ok: false, aborted: false, empty: false, error: "summary was empty or incomplete" });
      assert.deepEqual(msgs, copy);
      net.restore();
    }
  });

  test("有会话文件时落盘：分隔、摘要、保留段，恢复后与内存一致", async () => {
    net = fakeFetch([summaryReply()]);
    const msgs: Message[] = [];
    for (const m of history()) session.pushMessage(msgs, m);
    const file = session.sessionFile()!;
    assert.ok(file);
    const r = await runCompact(msgs);
    assert.equal(r.ok, true);
    assert.deepEqual(session.loadMessages(file), msgs);
    session.endSession();
  });
});
