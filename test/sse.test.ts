// llm/sse.ts：SSE 帧切分、跨包拼接、忽略非 data 行与 [DONE]
import { test } from "node:test";
import assert from "node:assert/strict";
import { sseJson } from "../src/llm/sse.ts";

// 把若干段文字包成一个分包到达的 Response
function chunked(parts: (string | Uint8Array)[]): Response {
  const enc = new TextEncoder();
  const queue = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(ctl) {
        const next = queue.shift();
        if (next) ctl.enqueue(next);
        else ctl.close();
      },
    }),
  );
}

// 读完整个流，收集解析出的对象
async function collect(res: Response): Promise<any[]> {
  const out: any[] = [];
  for await (const ev of sseJson(res)) out.push(ev);
  return out;
}

test("一包里多帧依次解析", async () => {
  assert.deepEqual(await collect(chunked(['data: {"a":1}\n\ndata: {"a":2}\n\n'])), [{ a: 1 }, { a: 2 }]);
});

test("一帧 JSON 跨多个包也能拼齐", async () => {
  assert.deepEqual(await collect(chunked(['data: {"te', 'xt":"hel', 'lo"}\n', "\n", 'data: {"n":2}\n\n'])), [
    { text: "hello" },
    { n: 2 },
  ]);
});

test("多字节字符被拆在两个包之间不乱码", async () => {
  const bytes = new TextEncoder().encode('data: {"t":"中文"}\n\n');
  // 「中」是 3 字节，从它中间切开
  const cut = bytes.indexOf(0xe4) + 1;
  assert.deepEqual(await collect(chunked([bytes.slice(0, cut), bytes.slice(cut)])), [{ t: "中文" }]);
});

test("[DONE]、空 data、event 行、注释行都跳过", async () => {
  const res = chunked(["event: message_start\ndata: {\"x\":1}\n\n", ": keepalive\n\n", "data:\n\n", "data: [DONE]\n\n"]);
  assert.deepEqual(await collect(res), [{ x: 1 }]);
});

test("data: 后面没有空格也认", async () => {
  assert.deepEqual(await collect(chunked(['data:{"k":true}\n\n'])), [{ k: true }]);
});

test("一个事件里多条 data 行各自解析", async () => {
  assert.deepEqual(await collect(chunked(['data: {"a":1}\ndata: {"b":2}\n\n'])), [{ a: 1 }, { b: 2 }]);
});

test("流结束时没有空行收尾的最后一帧不交出", async () => {
  assert.deepEqual(await collect(chunked(['data: {"a":1}\n\ndata: {"b":2}'])), [{ a: 1 }]);
});

test("坏 JSON 直接抛出", async () => {
  await assert.rejects(collect(chunked(["data: {oops\n\n"])), SyntaxError);
});

test("CRLF 分隔的帧也能解析", async () => {
  assert.deepEqual(
    await collect(chunked(['event: x\r\ndata: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\n'])),
    [{ a: 1 }, { a: 2 }],
  );
});

test("CRLF 分隔符被拆在两包之间也能拼上", async () => {
  assert.deepEqual(await collect(chunked(['data: {"a":1}\r\n\r', '\ndata: {"a":2}\r\n', "\r\n"])), [{ a: 1 }, { a: 2 }]);
});
