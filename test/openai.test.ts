// llm/openai.ts：经 callLLM + 假 fetch 检查请求线格式与流式回包的收拢
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { callLLM } from "../src/llm/index.ts";
import { TOOLS } from "../src/tools/index.ts";
import type { Message } from "../src/types.ts";
import { fakeFetch, fakeProvider, openaiStream, sse, type FakeFetch, type FakeReply } from "./helpers.ts";

let net: FakeFetch | undefined;
afterEach(() => {
  net?.restore();
  net = undefined;
});

// 装好罐头回包后发一次 openai 请求，返回结果、收到的文本碎片和发出的请求
async function call(replies: FakeReply[], messages: Message[] = [{ role: "user", content: "hi" }], tools: any[] = [], signal?: AbortSignal) {
  net = fakeFetch(replies);
  const deltas: string[] = [];
  const msg = await callLLM(fakeProvider("openai"), "SYSTEM", messages, tools, (d) => deltas.push(d), signal);
  return { msg, deltas, req: net.requests[0]! };
}

describe("请求", () => {
  test("地址、鉴权头、模型、max_tokens、stream 选项", async () => {
    const { req } = await call([{ frames: openaiStream({ text: ["x"], finish: "stop" }) }]);
    assert.equal(req.url, "https://fake.invalid/chat/completions");
    assert.equal(req.headers.authorization, "Bearer test-key");
    assert.equal(req.headers["content-type"], "application/json");
    assert.equal(req.body.model, "fake-model");
    assert.equal(req.body.max_tokens, 8192);
    assert.equal(req.body.stream, true);
    assert.deepEqual(req.body.stream_options, { include_usage: true });
  });

  test("没有工具时不带 tools 字段", async () => {
    const { req } = await call([{ frames: openaiStream({ finish: "stop" }) }]);
    assert.equal("tools" in req.body, false);
  });

  test("工具 schema 包成 function 形式", async () => {
    const { req } = await call([{ frames: openaiStream({ finish: "stop" }) }], undefined, TOOLS);
    assert.equal(req.body.tools.length, TOOLS.length);
    assert.deepEqual(req.body.tools[0], {
      type: "function",
      function: { name: TOOLS[0]!.name, description: TOOLS[0]!.description, parameters: TOOLS[0]!.input_schema },
    });
  });

  test("system 单独一条，assistant 文本与 tool_calls 分开，toolResult 1:1 成 tool", async () => {
    const history: Message[] = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "a" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "f" } },
          { type: "text", text: "b" },
          { type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } },
        ],
        stopReason: "toolUse",
        usage: { input: 0, output: 0 },
      },
      { role: "toolResult", toolCallId: "c1", toolName: "read", content: "R1", isError: false },
      { role: "toolResult", toolCallId: "c2", toolName: "bash", content: "R2", isError: true },
    ];
    const { req } = await call([{ frames: openaiStream({ finish: "stop" }) }], history);
    assert.deepEqual(req.body.messages, [
      { role: "system", content: "SYSTEM" },
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: "ab",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read", arguments: '{"path":"f"}' } },
          { id: "c2", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "R1" },
      { role: "tool", tool_call_id: "c2", content: "R2" },
    ]);
  });

  test("只有 tool_calls 的 assistant 其 content 是 null；只有文本的没有 tool_calls 字段", async () => {
    const history: Message[] = [
      { role: "user", content: "x" },
      { role: "assistant", content: [{ type: "toolCall", id: "c", name: "read", arguments: {} }], stopReason: "toolUse", usage: { input: 0, output: 0 } },
      { role: "toolResult", toolCallId: "c", toolName: "read", content: "r", isError: false },
      { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { input: 0, output: 0 } },
    ];
    const { req } = await call([{ frames: openaiStream({ finish: "stop" }) }], history);
    assert.equal(req.body.messages[2].content, null);
    assert.deepEqual(req.body.messages[4], { role: "assistant", content: "done" });
  });

  test("块数组的 user 原样作为 content 发出", async () => {
    const { req } = await call([{ frames: openaiStream({ finish: "stop" }) }], [{ role: "user", content: [{ type: "text", text: "blk" }] }]);
    assert.deepEqual(req.body.messages[1], { role: "user", content: [{ type: "text", text: "blk" }] });
  });
});

describe("回包", () => {
  test("文本碎片逐个交给 onText，最后拼成一块", async () => {
    const { msg, deltas } = await call([{ frames: openaiStream({ text: ["Hel", "lo", " 世界"], finish: "stop" }) }]);
    assert.deepEqual(deltas, ["Hel", "lo", " 世界"]);
    assert.deepEqual(msg.content, [{ type: "text", text: "Hello 世界" }]);
    assert.equal(msg.stopReason, "stop");
  });

  test("空字符串 content 不触发 onText", async () => {
    const { deltas, msg } = await call([{ frames: [sse({ choices: [{ delta: { content: "" } }] }), ...openaiStream({ finish: "stop" })] }]);
    assert.deepEqual(deltas, []);
    assert.deepEqual(msg.content, []);
  });

  test("tool_calls 按 index 跨帧拼参数，多个调用各自成块", async () => {
    const { msg } = await call([
      {
        frames: openaiStream({
          text: ["let me"],
          calls: [
            { id: "call_a", name: "read", args: ['{"pa', 'th":"a.', 'ts"}'] },
            { id: "call_b", name: "bash", args: ['{"command"', ':"echo hi"}'] },
          ],
          finish: "tool_calls",
        }),
      },
    ]);
    assert.equal(msg.stopReason, "toolUse");
    assert.deepEqual(msg.content, [
      { type: "text", text: "let me" },
      { type: "toolCall", id: "call_a", name: "read", arguments: { path: "a.ts" } },
      { type: "toolCall", id: "call_b", name: "bash", arguments: { command: "echo hi" } },
    ]);
  });

  test("交错到达的两个调用碎片按 index 各归各位", async () => {
    const tc = (index: number, extra: object) => sse({ choices: [{ delta: { tool_calls: [{ index, ...extra }] } }] });
    const { msg } = await call([
      {
        frames: [
          tc(0, { id: "x", function: { name: "read", arguments: '{"path"' } }),
          tc(1, { id: "y", function: { name: "read", arguments: '{"path"' } }),
          tc(0, { function: { arguments: ':"0"}' } }),
          tc(1, { function: { arguments: ':"1"}' } }),
          sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        ],
      },
    ]);
    assert.deepEqual(
      msg.content.map((b) => (b.type === "toolCall" ? [b.id, b.arguments.path] : null)),
      [
        ["x", "0"],
        ["y", "1"],
      ],
    );
  });

  test("参数为空串当成空对象", async () => {
    const { msg } = await call([{ frames: openaiStream({ calls: [{ id: "c", name: "read", args: [""] }], finish: "tool_calls" }) }]);
    assert.deepEqual(msg.content, [{ type: "toolCall", id: "c", name: "read", arguments: {} }]);
    assert.equal(msg.stopReason, "toolUse");
  });

  test("没收到 id 的调用丢掉", async () => {
    const { msg } = await call([{ frames: openaiStream({ calls: [{ name: "read", args: ["{}"] }], finish: "tool_calls" }) }]);
    assert.deepEqual(msg.content, []);
  });

  test("finish_reason 映射：stop、length、tool_calls、其它", async () => {
    const cases: [string, string][] = [
      ["stop", "stop"],
      ["length", "length"],
      ["tool_calls", "toolUse"],
      ["content_filter", "stop"],
    ];
    for (const [wire, internal] of cases) {
      const { msg } = await call([{ frames: openaiStream({ text: ["t"], finish: wire }) }]);
      assert.equal(msg.stopReason, internal, wire);
      net!.restore();
    }
  });

  test("没收到 finish_reason 就是 incomplete", async () => {
    const { msg } = await call([{ frames: openaiStream({ text: ["half"] }) }]);
    assert.equal(msg.stopReason, "incomplete");
    assert.deepEqual(msg.content, [{ type: "text", text: "half" }]);
  });

  test("tool_calls 结束但参数解不开是 badArgs，解不开的参数给空对象", async () => {
    const { msg } = await call([{ frames: openaiStream({ calls: [{ id: "c", name: "write", args: ['{"path":"a", "con'] }], finish: "tool_calls" }) }]);
    assert.equal(msg.stopReason, "badArgs");
    assert.deepEqual(msg.content, [{ type: "toolCall", id: "c", name: "write", arguments: {} }]);
  });

  test("stop 结束但参数解不开也是 badArgs", async () => {
    const { msg } = await call([{ frames: openaiStream({ calls: [{ id: "c", name: "write", args: ["{"] }], finish: "stop" }) }]);
    assert.equal(msg.stopReason, "badArgs");
  });

  test("length 结束时参数解不开仍是 length", async () => {
    const { msg } = await call([{ frames: openaiStream({ calls: [{ id: "c", name: "write", args: ["{"] }], finish: "length" }) }]);
    assert.equal(msg.stopReason, "length");
  });

  test("usage 取 prompt_tokens 与 completion_tokens；没有就是 0", async () => {
    const withUsage = await call([{ frames: openaiStream({ text: ["t"], finish: "stop", usage: { prompt_tokens: 120, completion_tokens: 7 } }) }]);
    assert.deepEqual(withUsage.msg.usage, { input: 120, output: 7 });
    net!.restore();
    const without = await call([{ frames: openaiStream({ text: ["t"], finish: "stop" }) }]);
    assert.deepEqual(without.msg.usage, { input: 0, output: 0 });
  });

  test("非 2xx 抛出 API error <状态码>: <正文>", async () => {
    await assert.rejects(call([{ status: 401, body: '{"error":"bad key"}' }]), {
      message: 'API error 401: {"error":"bad key"}',
    });
  });
});

describe("中断", () => {
  test("流中途打断：已收到的文本作为结果返回", async () => {
    const ac = new AbortController();
    const { msg } = await call([{ frames: openaiStream({ text: ["par", "tial"], done: false }), hang: () => ac.abort() }], undefined, [], ac.signal);
    assert.deepEqual(msg.content, [{ type: "text", text: "partial" }]);
    assert.equal(msg.stopReason, "incomplete");
  });

  test("流中途打断：已收到 id 的半截调用也返回", async () => {
    const ac = new AbortController();
    const { msg } = await call(
      [{ frames: openaiStream({ calls: [{ id: "c1", name: "bash", args: ['{"comm'] }], done: false }), hang: () => ac.abort() }],
      undefined,
      [],
      ac.signal,
    );
    assert.equal(msg.content.length, 1);
    assert.equal(msg.content[0]!.type, "toolCall");
  });

  test("什么都没收到就打断：抛 AbortError", async () => {
    const ac = new AbortController();
    await assert.rejects(call([{ frames: [], hang: () => ac.abort() }], undefined, [], ac.signal), { name: "AbortError" });
  });

  test("发请求前已打断：抛 AbortError，不发出请求", async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(call([{ frames: openaiStream({ text: ["x"], finish: "stop" }) }], undefined, [], ac.signal), { name: "AbortError" });
    assert.equal(net!.requests.length, 0);
  });
});
