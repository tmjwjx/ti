// 测试共用：临时 HOME 与项目目录、假 fetch 与罐头 SSE、记录事件的 AgentUI
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentUI } from "../src/core/agent.ts";
import type { ProviderConf, ToolCall } from "../src/types.ts";

export type Sandbox = { root: string; home: string; project: string };

// 建一份临时 HOME 和项目目录，把 HOME 指过去并切进项目目录，进程退出时删掉
export function isolate(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ti-test-")));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  process.env.HOME = home;
  process.chdir(project);
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  return { root, home, project };
}

export type FakeReply = {
  status?: number; // 非 200 时 body 当错误正文
  body?: string;
  frames?: string[]; // 每一项是一个网络包，可以是半帧
  hang?: () => void; // 给了就在包发完后卡住，并调它一次；之后只能靠 abort 结束
};

export type SentRequest = { url: string; headers: Record<string, string>; body: any };

export type FakeFetch = { requests: SentRequest[]; restore(): void };

// 把 globalThis.fetch 换成按顺序回放罐头响应的假实现，记下每次请求
export function fakeFetch(replies: FakeReply[]): FakeFetch {
  const original = globalThis.fetch;
  const queue = [...replies];
  const requests: SentRequest[] = [];
  const enc = new TextEncoder();
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;
    requests.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const reply = queue.shift();
    if (!reply) throw new Error(`fake fetch: no scripted reply for request #${requests.length}`);
    if (reply.status && reply.status !== 200) return new Response(reply.body ?? "", { status: reply.status });
    const frames = [...(reply.frames ?? [])];
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) {
        signal?.addEventListener("abort", () => ctl.error(signal.reason), { once: true });
      },
      pull(ctl) {
        const next = frames.shift();
        if (next !== undefined) {
          ctl.enqueue(enc.encode(next));
          return;
        }
        if (!reply.hang) {
          ctl.close();
          return;
        }
        // 等读的一方把最后一包处理完再通知，之后一直挂着
        setImmediate(reply.hang);
        return new Promise<void>(() => {});
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  return {
    requests,
    restore() {
      globalThis.fetch = original;
    },
  };
}

// 一个 SSE 帧
export function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export type OpenAICall = { id?: string; name: string; args: string[] };

// 拼一段 OpenAI chat/completions 流：文本碎片、按 index 分片的 tool_calls、结束原因、用量
export function openaiStream(opts: {
  text?: string[];
  calls?: OpenAICall[];
  finish?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
  done?: boolean;
}): string[] {
  const out: string[] = [];
  for (const t of opts.text ?? []) out.push(sse({ choices: [{ index: 0, delta: { content: t } }] }));
  (opts.calls ?? []).forEach((c, index) => {
    const [first = "", ...rest] = c.args;
    out.push(
      sse({
        choices: [
          { index: 0, delta: { tool_calls: [{ index, ...(c.id ? { id: c.id } : {}), type: "function", function: { name: c.name, arguments: first } }] } },
        ],
      }),
    );
    for (const piece of rest) {
      out.push(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: piece } }] } }] }));
    }
  });
  if (opts.finish) out.push(sse({ choices: [{ index: 0, delta: {}, finish_reason: opts.finish }] }));
  if (opts.usage) out.push(sse({ choices: [], usage: opts.usage }));
  if (opts.done !== false) out.push("data: [DONE]\n\n");
  return out;
}

export type AnthropicCall = { id: string; name: string; json?: string[]; input?: unknown };

// 拼一段 Anthropic Messages 流：message_start 用量、文本块、tool_use 块、message_delta 结束原因
export function anthropicStream(opts: {
  text?: string[];
  calls?: AnthropicCall[];
  stop?: string;
  usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  output?: number;
}): string[] {
  const out: string[] = [sse({ type: "message_start", message: { usage: opts.usage ?? { input_tokens: 0 } } })];
  let index = 0;
  if (opts.text) {
    out.push(sse({ type: "content_block_start", index, content_block: { type: "text", text: "" } }));
    for (const t of opts.text) out.push(sse({ type: "content_block_delta", index, delta: { type: "text_delta", text: t } }));
    out.push(sse({ type: "content_block_stop", index }));
    index += 1;
  }
  for (const c of opts.calls ?? []) {
    const block: Record<string, unknown> = { type: "tool_use", id: c.id, name: c.name };
    if ("input" in c) block.input = c.input;
    out.push(sse({ type: "content_block_start", index, content_block: block }));
    for (const j of c.json ?? []) {
      out.push(sse({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: j } }));
    }
    out.push(sse({ type: "content_block_stop", index }));
    index += 1;
  }
  if (opts.stop || opts.output !== undefined) {
    out.push(sse({ type: "message_delta", delta: opts.stop ? { stop_reason: opts.stop } : {}, usage: { output_tokens: opts.output ?? 0 } }));
  }
  out.push(sse({ type: "message_stop" }));
  return out;
}

// 一份能发请求的假厂家配置，地址不会真的被访问
export function fakeProvider(protocol: "openai" | "anthropic", extra: Partial<ProviderConf> = {}): ProviderConf {
  return {
    name: protocol === "openai" ? "fake-openai" : "fake-anthropic",
    protocol,
    baseURL: "https://fake.invalid",
    model: "fake-model",
    apiKey: "test-key",
    auth: protocol === "openai" ? "bearer" : "x-api-key",
    ...extra,
  };
}

export type UIEvent =
  | { kind: "text"; text: string }
  | { kind: "toolCall"; call: ToolCall }
  | { kind: "result"; text: string; isError: boolean }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

// 一个把 agent 事件按顺序记下来的 AgentUI，可挂钩子在工具调用时做事
export function recordUI(hooks: { onToolCall?: (tc: ToolCall) => void } = {}): {
  ui: AgentUI;
  events: UIEvent[];
  text(): string;
} {
  const events: UIEvent[] = [];
  const ui: AgentUI = {
    text: (d) => events.push({ kind: "text", text: d }),
    toolCall: (call) => {
      events.push({ kind: "toolCall", call });
      hooks.onToolCall?.(call);
    },
    result: (text, isError) => events.push({ kind: "result", text, isError }),
    info: (text) => events.push({ kind: "info", text }),
    error: (text) => events.push({ kind: "error", text }),
  };
  return {
    ui,
    events,
    text: () => events.filter((e) => e.kind === "text").map((e) => (e as { text: string }).text).join(""),
  };
}

// 去掉 ANSI 颜色码，断言只看字
export function plain(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
