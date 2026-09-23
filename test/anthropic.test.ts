// llm/anthropic.ts：经 callLLM + 假 fetch 检查 Messages 线格式、content_block 累积与用量
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { callLLM } from "../src/llm/index.ts";
import { TOOLS } from "../src/tools/index.ts";
import type { Message, ProviderConf } from "../src/types.ts";
import { anthropicStream, fakeFetch, fakeProvider, sse, type FakeFetch, type FakeReply } from "./helpers.ts";

let net: FakeFetch | undefined;
afterEach(() => {
  net?.restore();
  net = undefined;
});

// 装好罐头回包后发一次 anthropic 请求，返回结果、文本碎片和发出的请求
async function call(
  replies: FakeReply[],
  messages: Message[] = [{ role: "user", content: "hi" }],
  opts: { tools?: any[]; signal?: AbortSignal; provider?: Partial<ProviderConf> } = {},
) {
  net = fakeFetch(replies);
  const deltas: string[] = [];
  const msg = await callLLM(fakeProvider("anthropic", opts.provider), "SYSTEM", messages, opts.tools ?? [], (d) => deltas.push(d), opts.signal);
  return { msg, deltas, req: net.requests[0]! };
}

describe("请求", () => {
  test("地址、版本头、x-api-key、system、max_tokens", async () => {
    const { req } = await call([{ frames: anthropicStream({ text: ["x"], stop: "end_turn" }) }]);
    assert.equal(req.url, "https://fake.invalid/v1/messages");
    assert.equal(req.headers["anthropic-version"], "2023-06-01");
    assert.equal(req.headers["x-api-key"], "test-key");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.body.system, "SYSTEM");
    assert.equal(req.body.max_tokens, 16384);
    assert.equal(req.body.stream, true);
    assert.equal(req.body.model, "fake-model");
  });

  test("auth 为 bearer 时走 Authorization 头", async () => {
    const { req } = await call([{ frames: anthropicStream({ stop: "end_turn" }) }], undefined, { provider: { auth: "bearer" } });
    assert.equal(req.headers.authorization, "Bearer test-key");
    assert.equal(req.headers["x-api-key"], undefined);
  });

  test("工具 schema 原样发出；没有工具时不带 tools 字段", async () => {
    const withTools = await call([{ frames: anthropicStream({ stop: "end_turn" }) }], undefined, { tools: TOOLS });
    assert.deepEqual(withTools.req.body.tools, TOOLS);
    net!.restore();
    const without = await call([{ frames: anthropicStream({ stop: "end_turn" }) }]);
    assert.equal("tools" in without.req.body, false);
  });

  test("连续 toolResult 归并成一条 user，后面的 user 文本接在同一条里", async () => {
    const history: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
          { type: "toolCall", id: "t2", name: "bash", arguments: { command: "x" } },
        ],
        stopReason: "toolUse",
        usage: { input: 0, output: 0 },
      },
      { role: "toolResult", toolCallId: "t1", toolName: "read", content: "A", isError: false },
      { role: "toolResult", toolCallId: "t2", toolName: "bash", content: "B", isError: true },
      { role: "user", content: "and then" },
    ];
    const { req } = await call([{ frames: anthropicStream({ stop: "end_turn" }) }], history);
    assert.deepEqual(req.body.messages, [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "t1", name: "read", input: { path: "a" } },
          { type: "tool_use", id: "t2", name: "bash", input: { command: "x" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "A", is_error: false },
          { type: "tool_result", tool_use_id: "t2", content: "B", is_error: true },
          { type: "text", text: "and then" },
        ],
      },
    ]);
  });

  test("两轮工具之间各自一条 user，角色交替", async () => {
    const call1 = { type: "toolCall" as const, id: "a", name: "read", arguments: {} };
    const call2 = { type: "toolCall" as const, id: "b", name: "read", arguments: {} };
    const history: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: [call1], stopReason: "toolUse", usage: { input: 0, output: 0 } },
      { role: "toolResult", toolCallId: "a", toolName: "read", content: "1", isError: false },
      { role: "assistant", content: [call2], stopReason: "toolUse", usage: { input: 0, output: 0 } },
      { role: "toolResult", toolCallId: "b", toolName: "read", content: "2", isError: false },
    ];
    const { req } = await call([{ frames: anthropicStream({ stop: "end_turn" }) }], history);
    assert.deepEqual(
      req.body.messages.map((m: any) => m.role),
      ["user", "assistant", "user", "assistant", "user"],
    );
  });
});

describe("回包", () => {
  test("文本增量交给 onText 并拼成一块", async () => {
    const { msg, deltas } = await call([{ frames: anthropicStream({ text: ["你", "好"], stop: "end_turn" }) }]);
    assert.deepEqual(deltas, ["你", "好"]);
    assert.deepEqual(msg.content, [{ type: "text", text: "你好" }]);
    assert.equal(msg.stopReason, "stop");
  });

  test("tool_use 的 input_json_delta 跨帧拼成参数", async () => {
    const { msg } = await call([
      {
        frames: anthropicStream({
          text: ["checking"],
          calls: [{ id: "tu_1", name: "read", input: {}, json: ['{"pa', 'th": "x.ts"', "}"] }],
          stop: "tool_use",
        }),
      },
    ]);
    assert.equal(msg.stopReason, "toolUse");
    assert.deepEqual(msg.content, [
      { type: "text", text: "checking" },
      { type: "toolCall", id: "tu_1", name: "read", arguments: { path: "x.ts" } },
    ]);
  });

  test("start 就带完整 input、后面没有 json 碎片时用 start 的 input", async () => {
    const { msg } = await call([{ frames: anthropicStream({ calls: [{ id: "t", name: "bash", input: { command: "ls" } }], stop: "tool_use" }) }]);
    assert.deepEqual(msg.content, [{ type: "toolCall", id: "t", name: "bash", arguments: { command: "ls" } }]);
    assert.equal(msg.stopReason, "toolUse");
  });

  test("start 的 input 是空对象且没有碎片：合法空参数", async () => {
    const { msg } = await call([{ frames: anthropicStream({ calls: [{ id: "t", name: "read", input: {} }], stop: "tool_use" }) }]);
    assert.equal(msg.stopReason, "toolUse");
    assert.deepEqual(msg.content, [{ type: "toolCall", id: "t", name: "read", arguments: {} }]);
  });

  test("start 没带 input、也没有碎片：badArgs", async () => {
    const { msg } = await call([{ frames: anthropicStream({ calls: [{ id: "t", name: "read" }], stop: "tool_use" }) }]);
    assert.equal(msg.stopReason, "badArgs");
  });

  test("参数 JSON 解不开：tool_use 与 end_turn 都变 badArgs，max_tokens 仍是 length", async () => {
    for (const [stop, want] of [
      ["tool_use", "badArgs"],
      ["end_turn", "badArgs"],
      ["max_tokens", "length"],
    ] as const) {
      const { msg } = await call([{ frames: anthropicStream({ calls: [{ id: "t", name: "write", input: {}, json: ['{"path":'] }], stop }) }]);
      assert.equal(msg.stopReason, want, stop);
      net!.restore();
    }
  });

  test("stop_reason 映射：end_turn、stop_sequence → stop，max_tokens → length，tool_use → toolUse", async () => {
    for (const [wire, internal] of [
      ["end_turn", "stop"],
      ["stop_sequence", "stop"],
      ["max_tokens", "length"],
      ["tool_use", "toolUse"],
    ] as const) {
      const { msg } = await call([{ frames: anthropicStream({ text: ["t"], stop: wire }) }]);
      assert.equal(msg.stopReason, internal, wire);
      net!.restore();
    }
  });

  test("没收到 stop_reason 就是 incomplete", async () => {
    const { msg } = await call([{ frames: anthropicStream({ text: ["t"] }) }]);
    assert.equal(msg.stopReason, "incomplete");
  });

  test("后一条不带 stop_reason 的 message_delta 不冲掉已有结束原因", async () => {
    const frames = [
      ...anthropicStream({ text: ["t"], stop: "end_turn", output: 3 }).slice(0, -1),
      sse({ type: "message_delta", delta: {}, usage: { output_tokens: 9 } }),
      sse({ type: "message_stop" }),
    ];
    const { msg } = await call([{ frames }]);
    assert.equal(msg.stopReason, "stop");
    assert.equal(msg.usage.output, 9);
  });

  test("input 用量 = input + cache_read + cache_creation，output 取 message_delta", async () => {
    const { msg } = await call([
      {
        frames: anthropicStream({
          text: ["t"],
          stop: "end_turn",
          usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
          output: 42,
        }),
      },
    ]);
    assert.deepEqual(msg.usage, { input: 1210, output: 42 });
  });

  test("缓存字段缺失时按 0 计", async () => {
    const { msg } = await call([{ frames: anthropicStream({ text: ["t"], stop: "end_turn", usage: { input_tokens: 5 }, output: 1 }) }]);
    assert.deepEqual(msg.usage, { input: 5, output: 1 });
  });

  test("不认识的块类型（thinking）被丢掉，不留空洞", async () => {
    const frames = [
      sse({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
      sse({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } }),
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
    ];
    const { msg, deltas } = await call([{ frames }]);
    assert.deepEqual(msg.content, [{ type: "text", text: "answer" }]);
    assert.deepEqual(deltas, ["answer"]);
  });

  test("流里的 error 事件抛出 API stream error", async () => {
    const frames = [sse({ type: "message_start", message: { usage: {} } }), sse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })];
    await assert.rejects(call([{ frames }]), { message: "API stream error: Overloaded" });
  });

  test("非 2xx 抛出 API error <状态码>: <正文>", async () => {
    await assert.rejects(call([{ status: 529, body: "overloaded" }]), { message: "API error 529: overloaded" });
  });
});

describe("中断", () => {
  test("流中途打断：已收到的文本作为结果返回", async () => {
    const ac = new AbortController();
    const frames = anthropicStream({ text: ["half"] }).slice(0, 3);
    const { msg } = await call([{ frames, hang: () => ac.abort() }], undefined, { signal: ac.signal });
    assert.deepEqual(msg.content, [{ type: "text", text: "half" }]);
    assert.equal(msg.stopReason, "incomplete");
  });

  test("只收到 message_start 就打断：抛 AbortError", async () => {
    const ac = new AbortController();
    const frames = anthropicStream({}).slice(0, 1);
    await assert.rejects(call([{ frames, hang: () => ac.abort() }], undefined, { signal: ac.signal }), { name: "AbortError" });
  });
});
