// core/agent.ts：agentTurn 在假 fetch + 真工具（临时目录）下的整轮流程、中断与流失败收尾
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, ToolResultMessage } from "../src/types.ts";
import { anthropicStream, fakeFetch, fakeProvider, isolate, openaiStream, recordUI, type FakeFetch, type FakeReply } from "./helpers.ts";

const box = isolate();
const { setProvider } = await import("../src/config/index.ts");
const { agentTurn } = await import("../src/core/agent.ts");
const session = await import("../src/core/session.ts");
const { toLlm } = await import("../src/llm/index.ts");

let net: FakeFetch | undefined;
beforeEach(() => {
  session.endSession();
  setProvider(fakeProvider("openai"));
});
afterEach(() => {
  net?.restore();
  net = undefined;
});

// 一个 openai 工具调用回包
function toolReply(calls: { id: string; name: string; args: object }[], finish = "tool_calls"): FakeReply {
  return { frames: openaiStream({ calls: calls.map((c) => ({ id: c.id, name: c.name, args: [JSON.stringify(c.args)] })), finish }) };
}

// 一个 openai 纯文本回包
function textReply(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): FakeReply {
  return { frames: openaiStream({ text: [text], finish: "stop", usage }) };
}

// 装好回包，从一句用户输入开始跑一轮，返回消息、事件和发出的请求
async function turn(replies: FakeReply[], opts: { input?: string; messages?: Message[]; signal?: AbortSignal; hooks?: Parameters<typeof recordUI>[0] } = {}) {
  net = fakeFetch(replies);
  const rec = recordUI(opts.hooks);
  const messages = opts.messages ?? [];
  session.pushMessage(messages, { role: "user", content: opts.input ?? "go" });
  await agentTurn(messages, { systemPrompt: "SYS", ui: rec.ui, signal: opts.signal });
  return { messages, rec, requests: net.requests };
}

// 取出所有工具结果消息
function results(messages: Message[]): ToolResultMessage[] {
  return messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
}

describe("正常流程", () => {
  test("纯文本回复：流式交给 ui.text，写入 assistant，打 token 行", async () => {
    const { messages, rec, requests } = await turn([textReply("你好！", { prompt_tokens: 1234, completion_tokens: 5 })]);
    assert.equal(requests.length, 1);
    assert.equal(rec.text(), "你好！");
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
    assert.deepEqual(messages[1], {
      role: "assistant",
      content: [{ type: "text", text: "你好！" }],
      stopReason: "stop",
      usage: { input: 1234, output: 5 },
    });
    assert.deepEqual(rec.events.at(-1), { kind: "info", text: "  1,234 in · 5 out" });
    assert.equal(requests[0]!.body.messages[0].content, "SYS");
    assert.ok(requests[0]!.body.tools.length >= 4);
  });

  test("用量全 0 时不打 token 行", async () => {
    const { rec } = await turn([textReply("ok")]);
    assert.equal(rec.events.filter((e) => e.kind === "info").length, 0);
  });

  test("正常结束但无字无工具：不写空 assistant", async () => {
    const { messages } = await turn([{ frames: openaiStream({ finish: "stop" }) }]);
    assert.deepEqual(messages.map((m) => m.role), ["user"]);
  });

  test("工具调用：真的执行 write、read、bash，结果回灌到下一次请求", async () => {
    const { messages, rec, requests } = await turn([
      toolReply([
        { id: "c1", name: "write", args: { path: "sub/hello.txt", content: "hello" } },
        { id: "c2", name: "read", args: { path: "sub/hello.txt" } },
        { id: "c3", name: "bash", args: { command: "cat sub/hello.txt && echo ' world'" } },
      ]),
      textReply("done"),
    ]);
    assert.equal(readFileSync(join(box.project, "sub", "hello.txt"), "utf8"), "hello");
    assert.deepEqual(
      results(messages).map((r) => [r.toolCallId, r.content, r.isError]),
      [
        ["c1", "wrote 5 bytes to sub/hello.txt", false],
        ["c2", "     1\thello", false],
        ["c3", "hello world", false],
      ],
    );
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "toolResult", "toolResult", "toolResult", "assistant"]);
    assert.equal(requests.length, 2);
    const wire = requests[1]!.body.messages;
    assert.deepEqual(
      wire.slice(3).map((m: any) => [m.role, m.tool_call_id, m.content]),
      [
        ["tool", "c1", "wrote 5 bytes to sub/hello.txt"],
        ["tool", "c2", "     1\thello"],
        ["tool", "c3", "hello world"],
      ],
    );
    assert.deepEqual(
      rec.events.filter((e) => e.kind === "toolCall").map((e) => (e as any).call.name),
      ["write", "read", "bash"],
    );
  });

  test("stop 结束但带完整调用也执行", async () => {
    const { messages } = await turn([toolReply([{ id: "s1", name: "write", args: { path: "s.txt", content: "x" } }], "stop"), textReply("ok")]);
    assert.ok(existsSync(join(box.project, "s.txt")));
    assert.equal(results(messages)[0]!.isError, false);
  });

  test("工具失败转成 isError 结果回灌，循环继续", async () => {
    const { messages, rec } = await turn([
      toolReply([
        { id: "e1", name: "read", args: { path: "missing.txt" } },
        { id: "e2", name: "nope", args: {} },
      ]),
      textReply("sorry"),
    ]);
    const [r1, r2] = results(messages);
    assert.equal(r1!.isError, true);
    assert.match(r1!.content, /^Error: ENOENT/);
    assert.deepEqual([r2!.content, r2!.isError], ["Error: unknown tool: nope", true]);
    assert.equal(messages.at(-1)!.role, "assistant");
    assert.deepEqual(
      rec.events.filter((e) => e.kind === "result").map((e) => (e as any).isError),
      [true, true],
    );
  });

  test("会话文件与内存一致", async () => {
    const { messages } = await turn([toolReply([{ id: "p1", name: "bash", args: { command: "echo persisted" } }]), textReply("fin")]);
    assert.deepEqual(session.loadMessages(session.sessionFile()!), messages);
  });

  test("anthropic 协议整轮：tool_result 归进 user 发回", async () => {
    setProvider(fakeProvider("anthropic"));
    const { messages, requests } = await turn([
      { frames: anthropicStream({ calls: [{ id: "tu1", name: "bash", input: {}, json: ['{"command":"echo hi"}'] }], stop: "tool_use" }) },
      { frames: anthropicStream({ text: ["ok"], stop: "end_turn" }) },
    ]);
    assert.equal(results(messages)[0]!.content, "hi");
    assert.equal(requests[1]!.url, "https://fake.invalid/v1/messages");
    assert.deepEqual(requests[1]!.body.messages.at(-1), {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu1", content: "hi", is_error: false }],
    });
  });

  test("API 失败直接抛给调用方，只留下用户那句", async () => {
    net = fakeFetch([{ status: 500, body: "down" }]);
    const messages: Message[] = [];
    session.pushMessage(messages, { role: "user", content: "x" });
    await assert.rejects(agentTurn(messages, { systemPrompt: "S", ui: recordUI().ui }), { message: "API error 500: down" });
    assert.deepEqual(messages.map((m) => m.role), ["user"]);
  });
});

describe("流失败", () => {
  test("incomplete：写入 assistant，未配的调用补真实原因，停轮", async () => {
    const { messages, rec, requests } = await turn([
      { frames: openaiStream({ text: ["partial"], calls: [{ id: "i1", name: "write", args: ['{"path":"never.txt","content":"x"}'] }] }) },
    ]);
    assert.equal(requests.length, 1);
    assert.equal(existsSync(join(box.project, "never.txt")), false);
    assert.equal((messages[1] as any).stopReason, "incomplete");
    assert.deepEqual(results(messages).map((r) => [r.toolCallId, r.content, r.isError]), [
      ["i1", "Error: stream ended without finish_reason", true],
    ]);
    assert.deepEqual(rec.events.at(-1), { kind: "error", text: "Error: stream ended without finish_reason" });
  });

  test("badArgs：同样补原因并停轮", async () => {
    const { messages, requests } = await turn([
      { frames: openaiStream({ calls: [{ id: "b1", name: "write", args: ['{"path":"x"'] }], finish: "tool_calls" }) },
    ]);
    assert.equal(requests.length, 1);
    assert.equal((messages[1] as any).stopReason, "badArgs");
    assert.equal(results(messages)[0]!.content, "Error: tool call arguments were incomplete or invalid JSON");
  });

  test("incomplete 且没有调用：只写 assistant 并报错", async () => {
    const { messages, rec } = await turn([{ frames: openaiStream({ text: ["cut"] }) }]);
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal(rec.events.at(-1)!.kind, "error");
  });

  test("流中途抛错：已打出的字存成没说完的回复，用户这句还在", async () => {
    setProvider(fakeProvider("anthropic"));
    const frames = anthropicStream({ text: ["半截回复"] });
    frames.pop();
    frames.push(`data: ${JSON.stringify({ type: "error", error: { message: "Overloaded" } })}\n\n`);
    net = fakeFetch([{ frames }]);
    const rec = recordUI();
    const messages: Message[] = [];
    session.pushMessage(messages, { role: "user", content: "问" });
    await assert.rejects(agentTurn(messages, { systemPrompt: "S", ui: rec.ui }), { message: "API stream error: Overloaded" });
    assert.equal(rec.text(), "半截回复");
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal((messages[1] as any).stopReason, "incomplete");
    assert.deepEqual((messages[1] as any).content, [{ type: "text", text: "半截回复" }]);
    // 没说完的正文要能再发给模型，不能整条当成被打断的尝试丢掉
    assert.equal(toLlm(messages).at(-1)?.role, "assistant");
  });
});

describe("length 截断", () => {
  const truncated = "Error: response hit the output token limit, so tool call arguments may be truncated. Re-issue the tool call with complete arguments.";

  test("带调用的 length：不执行，补截断原因后重问", async () => {
    const { messages, requests } = await turn([
      toolReply([{ id: "l1", name: "write", args: { path: "len.txt", content: "x" } }], "length"),
      textReply("retry ok"),
    ]);
    assert.equal(requests.length, 2);
    assert.equal(existsSync(join(box.project, "len.txt")), false);
    assert.deepEqual(results(messages).map((r) => [r.content, r.isError]), [[truncated, true]]);
    assert.equal(messages.at(-1)!.role, "assistant");
  });

  test("连续 3 次都截断就停轮", async () => {
    const reply = () => toolReply([{ id: `x${Math.random()}`, name: "bash", args: { command: "echo no" } }], "length");
    const { messages, rec, requests } = await turn([reply(), reply(), reply(), textReply("never")]);
    assert.equal(requests.length, 3);
    assert.equal(results(messages).length, 3);
    assert.deepEqual(rec.events.at(-1), { kind: "error", text: "Error: stopped after 3 consecutive tool calls that were not executed" });
  });

  test("中间有一次正常执行就重新计数", async () => {
    const cut = (id: string) => toolReply([{ id, name: "bash", args: { command: "echo c" } }], "length");
    const ok = (id: string) => toolReply([{ id, name: "bash", args: { command: "echo ok" } }]);
    const { requests } = await turn([cut("a"), cut("b"), ok("c"), cut("d"), cut("e"), textReply("end")]);
    assert.equal(requests.length, 6);
  });

  test("不带调用的 length：文字留下，结束", async () => {
    const { messages, requests } = await turn([{ frames: openaiStream({ text: ["long answer"], finish: "length" }) }]);
    assert.equal(requests.length, 1);
    assert.equal((messages[1] as any).stopReason, "length");
  });
});

describe("中断", () => {
  test("开始前已打断：不发请求，存一条空的 aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const { messages, rec, requests } = await turn([textReply("never")], { signal: ac.signal });
    assert.equal(requests.length, 0);
    assert.deepEqual(messages[1], { role: "assistant", content: [], stopReason: "aborted", usage: { input: 0, output: 0 } });
    assert.deepEqual(rec.events, [{ kind: "info", text: "[interrupted]" }]);
  });

  test("流中途打断：最后一条是带半截文字的 aborted，不补工具结果", async () => {
    const ac = new AbortController();
    const { messages, rec } = await turn(
      [{ frames: openaiStream({ text: ["写到一半"], calls: [{ id: "h1", name: "bash", args: ['{"comm'] }], done: false }), hang: () => ac.abort() }],
      { signal: ac.signal },
    );
    const last = messages.at(-1)!;
    assert.equal(last.role, "assistant");
    assert.equal((last as any).stopReason, "aborted");
    assert.deepEqual((last as any).content[0], { type: "text", text: "写到一半" });
    assert.equal(results(messages).length, 0);
    assert.equal(rec.events.filter((e) => e.kind === "info" && e.text === "[interrupted]").length, 1);
  });

  test("零字节被打断：存空 aborted；下一轮请求里两句 user 合成一条", async () => {
    const ac = new AbortController();
    const first = await turn([{ frames: [], hang: () => ac.abort() }], { input: "第一句", signal: ac.signal });
    assert.deepEqual(first.messages.at(-1), { role: "assistant", content: [], stopReason: "aborted", usage: { input: 0, output: 0 } });
    net!.restore();
    const second = await turn([textReply("答")], { input: "第二句", messages: first.messages });
    assert.deepEqual(second.requests[0]!.body.messages, [
      { role: "system", content: "SYS" },
      { role: "user", content: "第一句\n\n第二句" },
    ]);
    assert.deepEqual(toLlm(second.messages).map((m) => m.role), ["user", "assistant"]);
  });

  test("流中途打断后下一轮不带半截调用", async () => {
    const ac = new AbortController();
    const first = await turn(
      [{ frames: openaiStream({ calls: [{ id: "z1", name: "write", args: ['{"path":"a"'] }], done: false }), hang: () => ac.abort() }],
      { input: "a", signal: ac.signal },
    );
    net!.restore();
    const second = await turn([textReply("fine")], { input: "b", messages: first.messages });
    const wire = second.requests[0]!.body.messages;
    assert.equal(wire.length, 2);
    assert.equal(wire.some((m: any) => m.tool_calls || m.role === "tool"), false);
  });

  // sleep 远长于测试超时：没被杀就不会自然结束，超时只防卡死
  test("工具跑到一半被打断：正在跑的 bash 被杀，没跑的调用补 aborted by user", { timeout: 20_000 }, async () => {
    const ac = new AbortController();
    const { messages, rec, requests } = await turn(
      [
        toolReply([
          { id: "k1", name: "bash", args: { command: "sleep 60" } },
          { id: "k2", name: "write", args: { path: "after.txt", content: "no" } },
        ]),
      ],
      {
        signal: ac.signal,
        // toolCall 事件之后 agent 同步调 runTool 起进程；放到微任务里 abort，保证打断的是已经跑起来的 bash
        hooks: { onToolCall: (tc) => tc.name === "bash" && queueMicrotask(() => ac.abort()) },
      },
    );
    assert.equal(requests.length, 1);
    assert.equal(existsSync(join(box.project, "after.txt")), false);
    const [r1, r2] = results(messages);
    assert.equal(r1!.toolCallId, "k1");
    assert.match(r1!.content, /\[killed by SIGTERM \(interrupted\)\]/);
    assert.deepEqual([r2!.toolCallId, r2!.content, r2!.isError], ["k2", "Error: aborted by user", true]);
    assert.equal(messages.at(-1)!.role, "toolResult");
    assert.deepEqual(rec.events.slice(-2), [
      { kind: "result", text: "Error: aborted by user", isError: true },
      { kind: "info", text: "[interrupted]" },
    ]);
    // 打断后的历史协议合法：每个调用都有结果
    const ids = (messages[1] as any).content.filter((b: any) => b.type === "toolCall").map((b: any) => b.id);
    assert.deepEqual(results(messages).map((r) => r.toolCallId), ids);
  });

  test("最后一个工具跑完那一刻被打断：没有要补的，存一条 aborted", async () => {
    const ac = new AbortController();
    const { messages } = await turn([toolReply([{ id: "q1", name: "bash", args: { command: "echo quick" } }])], {
      signal: ac.signal,
      hooks: { onToolCall: () => ac.abort() },
    });
    // bash 在已打断的信号下立刻被杀，结果照样写入
    assert.equal(results(messages).length, 1);
    assert.equal(messages.at(-1)!.role, "assistant");
    assert.equal((messages.at(-1) as any).stopReason, "aborted");
  });
});

test("超过 100 轮就停", async () => {
  const replies: FakeReply[] = [];
  for (let i = 0; i < 101; i++) replies.push(toolReply([{ id: `m${i}`, name: "read", args: { path: "loop.txt" } }]));
  const messages: Message[] = [];
  net = fakeFetch(replies);
  const rec = recordUI();
  session.pushMessage(messages, { role: "user", content: "loop" });
  await agentTurn(messages, { systemPrompt: "S", ui: rec.ui });
  assert.equal(net.requests.length, 100);
  assert.deepEqual(rec.events.at(-1), { kind: "error", text: "\n[stopped: reached max 100 turns]" });
});
