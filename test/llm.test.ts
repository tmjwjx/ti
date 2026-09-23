// llm/index.ts：内部消息翻成协议三种角色、错误判别、按协议分发
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { callLLM, isAbortError, isContextOverflowError, toLlm } from "../src/llm/index.ts";
import type { AssistantMessage, Message } from "../src/types.ts";
import { fakeFetch, fakeProvider, openaiStream, anthropicStream, type FakeFetch } from "./helpers.ts";

const PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUFFIX = "\n</summary>";

// 一条带文字的 assistant，stopReason 可指定
function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], stopReason, usage: { input: 0, output: 0 } };
}

describe("toLlm", () => {
  test("user、assistant、toolResult 原样通过", () => {
    const msgs: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } }], stopReason: "toolUse", usage: { input: 1, output: 2 } },
      { role: "toolResult", toolCallId: "c1", toolName: "read", content: "x", isError: false },
    ];
    assert.deepEqual(toLlm(msgs), msgs);
  });

  test("aborted 的 assistant 整条丢掉，前后两条 user 合成一条", () => {
    const out = toLlm([{ role: "user", content: "first" }, assistant("half", "aborted"), { role: "user", content: "second" }]);
    assert.deepEqual(out, [{ role: "user", content: "first\n\nsecond" }]);
  });

  test("空的 aborted assistant 同样丢掉", () => {
    const out = toLlm([
      { role: "user", content: "a" },
      { role: "assistant", content: [], stopReason: "aborted", usage: { input: 0, output: 0 } },
    ]);
    assert.deepEqual(out, [{ role: "user", content: "a" }]);
  });

  test("aborted 里的半截工具调用不会带到请求里", () => {
    const out = toLlm([
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: {} }], stopReason: "aborted", usage: { input: 0, output: 0 } },
    ]);
    assert.equal(out.length, 1);
  });

  test("其它 stopReason 的 assistant 保留", () => {
    for (const r of ["stop", "length", "toolUse", "incomplete", "badArgs"] as const) {
      assert.equal(toLlm([assistant("x", r)]).length, 1, r);
    }
  });

  test("summary 翻成带 pi 前后缀的 user，两组文件清单都有", () => {
    const out = toLlm([{ role: "summary", text: "## Goal\nx", files: { read: ["a.ts", "b.ts"], modified: ["c.ts"] } }]);
    assert.deepEqual(out, [
      {
        role: "user",
        content: `${PREFIX}## Goal\nx\n\n<read-files>\na.ts\nb.ts\n</read-files>\n\n<modified-files>\nc.ts\n</modified-files>${SUFFIX}`,
      },
    ]);
  });

  test("summary 的空清单省掉对应标签", () => {
    assert.deepEqual(toLlm([{ role: "summary", text: "S", files: { read: [], modified: [] } }]), [
      { role: "user", content: `${PREFIX}S${SUFFIX}` },
    ]);
    assert.deepEqual(toLlm([{ role: "summary", text: "S", files: { read: ["r"], modified: [] } }]), [
      { role: "user", content: `${PREFIX}S\n\n<read-files>\nr\n</read-files>${SUFFIX}` },
    ]);
    assert.deepEqual(toLlm([{ role: "summary", text: "S", files: { read: [], modified: ["m"] } }]), [
      { role: "user", content: `${PREFIX}S\n\n<modified-files>\nm\n</modified-files>${SUFFIX}` },
    ]);
  });

  test("skill 翻成 <skill> 块，带目录说明；有参数时另起一段", () => {
    const withArgs = toLlm([{ role: "skill", name: "review", path: "/x/skills/review/SKILL.md", body: "Check it.", args: "src/a.ts" }]);
    assert.deepEqual(withArgs, [
      {
        role: "user",
        content:
          '<skill name="review" location="/x/skills/review/SKILL.md">\nReferences are relative to /x/skills/review.\n\nCheck it.\n</skill>\n\nsrc/a.ts',
      },
    ]);
    const noArgs = toLlm([{ role: "skill", name: "review", path: "/x/skills/review/SKILL.md", body: "Check it.", args: "" }]);
    assert.equal(
      noArgs[0]!.content,
      '<skill name="review" location="/x/skills/review/SKILL.md">\nReferences are relative to /x/skills/review.\n\nCheck it.\n</skill>',
    );
  });

  test("summary 后面紧跟 user 时合成一条", () => {
    const out = toLlm([{ role: "summary", text: "S", files: { read: [], modified: [] } }, { role: "user", content: "next" }]);
    assert.deepEqual(out, [{ role: "user", content: `${PREFIX}S${SUFFIX}\n\nnext` }]);
  });

  test("字符串与块数组的 user 合并成块数组", () => {
    const out = toLlm([
      { role: "user", content: "a" },
      { role: "user", content: [{ type: "text", text: "b" }, { type: "text", text: "c" }] },
      { role: "user", content: "d" },
    ]);
    assert.deepEqual(out, [
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
          { type: "text", text: "c" },
          { type: "text", text: "d" },
        ],
      },
    ]);
  });

  test("不相邻的 user 不合并", () => {
    const out = toLlm([{ role: "user", content: "a" }, assistant("r"), { role: "user", content: "b" }]);
    assert.equal(out.length, 3);
  });

  test("不改动传入的数组和消息", () => {
    const msgs: Message[] = [{ role: "user", content: "a" }, { role: "user", content: "b" }];
    const copy = structuredClone(msgs);
    toLlm(msgs);
    assert.deepEqual(msgs, copy);
  });
});

describe("isContextOverflowError", () => {
  test("400 且带各家超限措辞才算，忽略大小写", () => {
    for (const msg of [
      "API error 400: This model's maximum context length is 128000 tokens",
      "API error 400: {\"error\":\"Prompt is too long\"}",
      "API error 400: context length exceeded",
      "API error 400: Too Many Tokens in request",
    ]) {
      assert.equal(isContextOverflowError(new Error(msg)), true, msg);
    }
  });

  test("状态码不对或措辞不对都不算", () => {
    assert.equal(isContextOverflowError(new Error("API error 400: invalid tool schema")), false);
    assert.equal(isContextOverflowError(new Error("API error 413: prompt is too long")), false);
    assert.equal(isContextOverflowError(new Error("API error 4001: context length")), false);
    assert.equal(isContextOverflowError(new Error("maximum context length")), false);
  });

  test("不是 Error 不算", () => {
    assert.equal(isContextOverflowError("API error 400: context length"), false);
    assert.equal(isContextOverflowError(undefined), false);
  });
});

describe("isAbortError", () => {
  test("AbortController 的原因和同名 Error 都算", () => {
    const ac = new AbortController();
    ac.abort();
    assert.equal(isAbortError(ac.signal.reason), true);
    const e = new Error("x");
    e.name = "AbortError";
    assert.equal(isAbortError(e), true);
  });

  test("普通错误、超时错误、非 Error 不算", () => {
    assert.equal(isAbortError(new Error("AbortError")), false);
    assert.equal(isAbortError(new DOMException("t", "TimeoutError")), false);
    assert.equal(isAbortError({ name: "AbortError" }), false);
  });
});

describe("callLLM 按协议分发", () => {
  let net: FakeFetch | undefined;
  afterEach(() => net?.restore());

  test("openai 协议走 /chat/completions，发出前先过 toLlm", async () => {
    net = fakeFetch([{ frames: openaiStream({ text: ["ok"], finish: "stop" }) }]);
    const msg = await callLLM(
      fakeProvider("openai"),
      "SYS",
      [{ role: "user", content: "a" }, assistant("gone", "aborted"), { role: "user", content: "b" }],
      [],
      () => {},
    );
    assert.equal(net.requests[0]!.url, "https://fake.invalid/chat/completions");
    assert.deepEqual(net.requests[0]!.body.messages, [
      { role: "system", content: "SYS" },
      { role: "user", content: "a\n\nb" },
    ]);
    assert.equal(msg.stopReason, "stop");
  });

  test("anthropic 协议走 /v1/messages，summary 与 skill 翻成 user", async () => {
    net = fakeFetch([{ frames: anthropicStream({ text: ["ok"], stop: "end_turn" }) }]);
    await callLLM(
      fakeProvider("anthropic"),
      "SYS",
      [
        { role: "summary", text: "S", files: { read: [], modified: [] } },
        { role: "skill", name: "k", path: "/d/k/SKILL.md", body: "B", args: "" },
      ],
      [],
      () => {},
    );
    assert.equal(net.requests[0]!.url, "https://fake.invalid/v1/messages");
    const wire = net.requests[0]!.body.messages;
    assert.equal(wire.length, 1);
    assert.equal(wire[0].role, "user");
    assert.equal(
      wire[0].content,
      `${PREFIX}S${SUFFIX}\n\n<skill name="k" location="/d/k/SKILL.md">\nReferences are relative to /d/k.\n\nB\n</skill>`,
    );
  });
});
