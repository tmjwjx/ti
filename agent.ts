/**
 * ti —— 单文件极简 coding agent，架构参考 pi
 * (https://github.com/badlogic/pi-mono, packages/agent + packages/coding-agent)。
 *
 * 从 pi 借鉴的核心设计：
 *   - agent loop：流式请求 LLM → 执行 tool_use → tool_result 回灌 → 循环，直到模型不再调用工具
 *   - 只有 4 个工具：read / write / edit / bash，参数形状与 pi 完全一致
 *   - 极简系统提示词（<1k tokens）；没有 MCP、子 agent、plan mode、权限弹窗
 *   - max_tokens 截断的响应里的工具调用一律报错回灌、绝不执行（参数可能被截断，执行有风险）
 *   - 个人配置目录 ~/.ti/（参考 pi 的 ~/.pi/agent/），settings.json 存 provider/model/apiKey
 *
 * 双协议支持：
 *   - anthropic：Anthropic Messages API（官方或 Kimi 等兼容端点）
 *   - openai：  OpenAI chat/completions 兼容协议（DeepSeek 官方 API 等），内部统一转成 Block[]
 *
 * 零 npm 依赖：Node >= 22.6（原生 type-stripping 直接运行 .ts）。
 *
 * 文件结构（自顶向下）：
 *   配置体系 → 类型定义 → 系统提示词 → 工具定义/实现 → 双协议 SSE 调用 → agent 循环 → REPL → 入口
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";

// ================================================================ 配置体系
// 参考 pi 的 ~/.pi/agent/settings.json：个人配置放 ~/.ti/settings.json，例如：
//   { "provider": "deepseek",
//     "providers": { "deepseek":  { "model": "deepseek-chat", "apiKey": "sk-..." },
//                    "anthropic": { "baseURL": "https://api.kimi.com/coding/", "model": "k3" } } }
// 解析优先级（高 → 低）：CLI 参数 > 环境变量 > ~/.ti/settings.json > 内置预设
const SETTINGS_PATH = `${homedir()}/.ti/settings.json`;

type Protocol = "anthropic" | "openai";
/** 解析后的 provider 运行配置：协议、端点、模型、鉴权方式与密钥 */
interface ProviderConf {
  name: string;
  protocol: Protocol;
  baseURL: string;
  model: string;
  apiKey?: string;
  auth: "bearer" | "x-api-key"; // anthropic 协议两种风格：Bearer(Kimi 等) / x-api-key(官方)
}

/** 内置预设：protocol/baseURL/model 的默认值，均可被配置文件与环境变量覆盖 */
const PRESETS: Record<string, { protocol: Protocol; baseURL: string; model: string }> = {
  deepseek: { protocol: "openai", baseURL: "https://api.deepseek.com", model: "deepseek-chat" },
  anthropic: { protocol: "anthropic", baseURL: "https://api.anthropic.com", model: "k3" },
};

/** 读取 ~/.ti/settings.json；不存在或解析失败都按空配置处理（纯 env 也能跑） */
function loadSettings(): any {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/**
 * 按名字解析出完整的 provider 配置。
 * modelOverride 只来自 CLI -m/--model（最高优先级）；TI_MODEL 其次；
 * anthropic 协议还认 ANTHROPIC_MODEL。key 解析见下方注释。
 */
function resolveProvider(name: string, modelOverride?: string): ProviderConf {
  const conf = { ...(PRESETS[name] ?? {}), ...(settings.providers?.[name] ?? {}) };
  if (!conf.protocol)
    fail(`unknown provider "${name}"（内置预设：${Object.keys(PRESETS).join(" / ")}，或在 ${SETTINGS_PATH} 的 providers 里自定义）`);
  const isAnth = conf.protocol === "anthropic";
  const baseURL = (process.env.TI_BASE_URL ?? (isAnth ? process.env.ANTHROPIC_BASE_URL : process.env.OPENAI_BASE_URL) ?? conf.baseURL).replace(/\/+$/, "");
  const model = modelOverride ?? process.env.TI_MODEL ?? (isAnth ? process.env.ANTHROPIC_MODEL : undefined) ?? conf.model;
  // 密钥解析：env 优先于配置文件。anthropic 协议按 env 变量种类决定鉴权风格；
  // 配置文件里的 apiKey 默认 x-api-key，可用 "auth": "bearer" 覆盖（如 Kimi 端点）
  let apiKey: string | undefined;
  let auth: "bearer" | "x-api-key" = conf.auth ?? (isAnth ? "x-api-key" : "bearer");
  if (isAnth) {
    if (process.env.ANTHROPIC_AUTH_TOKEN) { apiKey = process.env.ANTHROPIC_AUTH_TOKEN; auth = "bearer"; }
    else if (process.env.ANTHROPIC_API_KEY) { apiKey = process.env.ANTHROPIC_API_KEY; auth = "x-api-key"; }
    else apiKey = conf.apiKey;
  } else {
    apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY ?? conf.apiKey;
  }
  if (!apiKey)
    fail(`provider "${name}" 没有 API key：请 export ${isAnth ? "ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY" : "DEEPSEEK_API_KEY"}，或在 ${SETTINGS_PATH} 的 providers.${name}.apiKey 里配置`);
  return { name, protocol: conf.protocol, baseURL, model, apiKey, auth };
}

const MAX_TURNS = 100; // 保险丝：单个用户输入最多允许的工具调用轮数，防死循环
const MAX_LINES = 2000; // 工具输出截断：最多保留 2000 行（与 pi 默认值一致）
const MAX_BYTES = 50 * 1024; //            且最多保留 50KB（同上）

// -------- 命令行参数解析
// --provider 选预设； -m/--model 指定模型； -p/--prompt 单发模式；其余位置参数拼成 prompt
let cliProvider: string | undefined;
let cliModel: string | undefined;
let prompt: string | undefined;
const rest: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--provider" && args[i + 1]) cliProvider = args[++i];
  else if ((a === "-m" || a === "--model") && args[i + 1]) cliModel = args[++i];
  else if ((a === "-p" || a === "--prompt") && args[i + 1]) prompt = args[++i];
  else if (a === "-h" || a === "--help") help(0);
  else rest.push(a);
}
prompt ??= rest.length ? rest.join(" ") : undefined;

/** 打印用法并以指定退出码结束进程（never 返回类型：此函数不返回） */
function help(code: number): never {
  console.log(`ti — minimal coding agent (pi-style)
usage: node agent.ts [--provider name] [-m model] [-p prompt | prompt words...]
  -p, --prompt     run a single prompt non-interactively (default: interactive REPL)
  -m, --model      model name (overrides env / config / preset default)
      --provider   provider: deepseek (default) | anthropic | custom names from settings.json
config: ~/.ti/settings.json — { "provider": "deepseek", "providers": { "<name>": { "baseURL", "model", "apiKey" } } }
env:    TI_PROVIDER / TI_MODEL / TI_BASE_URL
        DEEPSEEK_API_KEY (or OPENAI_API_KEY)      — for the openai protocol
        ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY — for the anthropic protocol`);
  process.exit(code);
}

// 启动时解析一次；REPL 里 /model 可随时切换（provider 是会话级可变状态）
const settings = loadSettings();
let provider = resolveProvider(cliProvider ?? process.env.TI_PROVIDER ?? settings.provider ?? "deepseek", cliModel);

// ================================================================= 类型定义
// 内部统一使用 Anthropic 风格的 content block（内容块）结构；
// OpenAI 协议路径在收发边界做双向转换，agent 循环与工具层无感知。
type TextBlock = { type: "text"; text: string };
// 模型发起的工具调用：id 用于把执行结果关联回这次调用；input 是解析后的参数对象
type ToolUse = { type: "tool_use"; id: string; name: string; input: any };
// 工具执行结果：is_error=true 告诉模型这次调用失败了，模型会据此自我纠正
type ToolResult = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
type Block = TextBlock | ToolUse | ToolResult;
// 对话消息：REPL 用户输入用纯字符串即可；assistant 消息与 tool_result 回灌用块数组
type Message = { role: "user" | "assistant"; content: string | Block[] };

// ============================================================== 系统提示词
/**
 * 构建 pi 风格的极简系统提示词（<1k tokens）：
 * 角色定位 + 4 个工具的一句话说明 + 行为准则 + 当前工作目录 + 日期。
 * 若 cwd 下存在 AGENTS.md / CLAUDE.md，作为 project_context 追加（pi 的同款做法），
 * 让 agent 自动获得项目级的约定说明。
 */
async function buildSystemPrompt(): Promise<string> {
  let projectContext = "";
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      projectContext += `\n\n<project_context path="${file}">\n${await readFile(file, "utf8")}\n</project_context>`;
    } catch {
      /* 文件不存在则跳过 */
    }
  }
  return `You are an expert coding assistant that helps users with software engineering tasks. You read, write and edit files, and run shell commands to get the job done.

Available tools:
- read: read a file with line numbers (use offset/limit to page)
- write: create or overwrite a file
- edit: targeted text replacements in a file (oldText must match exactly and uniquely)
- bash: run a shell command

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files
- Use bash for file exploration (ls, rg, find)
- Prefer edit for targeted changes; use write for new files or full rewrites
- Verify your work: build/test after changing code when possible

Current working directory: ${process.cwd()}
Current date: ${new Date().toISOString().slice(0, 10)}${projectContext}`;
}

// ================================================================ 工具定义
// 工具定义格式：name + description + input_schema(JSON Schema)。
// Anthropic 协议直接作为 tools 下发；OpenAI 协议在请求时包一层 {type:"function"}。
// 4 个工具的参数名与描述逐一对齐 pi 的 read/write/edit/bash。
const TOOLS = [
  {
    // read：带行号读文件；offset 从 1 开始，配合 limit 分页浏览大文件
    name: "read",
    description: "Read a text file with line numbers. Use offset/limit to page through large files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read (relative or absolute)" },
        offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
  },
  {
    // write：创建或覆盖文件；父目录不存在时自动递归创建
    name: "write",
    description: "Create or overwrite a file. Parent directories are created automatically.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to write (relative or absolute)" },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
    },
  },
  {
    // edit：一次调用可做多处替换。约束（也是 pi 的约束）：
    //   - oldText 必须与原文件逐字节一致（含缩进空白）
    //   - oldText 在文件里只能出现一次（唯一性），否则替换有歧义
    //   - 所有 edits 都针对「原文件」匹配，而不是逐个应用后的中间状态
    name: "edit",
    description:
      "Make one or more targeted replacements in a file. Each oldText must match the file content exactly (including whitespace) and occur exactly once. All edits are matched against the original file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
        edits: {
          type: "array",
          description: "Targeted replacements matched against the original file. Merge nearby changes into one edit; do not overlap.",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "Exact text to replace; must be unique in the file" },
              newText: { type: "string", description: "Replacement text" },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "edits"],
    },
  },
  {
    // bash：执行 shell 命令，返回合并的 stdout/stderr 与退出码；timeout 可选，默认不超时
    name: "bash",
    description: "Run a shell command and return its combined stdout/stderr and exit code.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
      },
      required: ["command"],
    },
  },
];

// 相对路径一律解析到进程启动目录（cwd），与 pi 的 resolveToCwd 一致
const resolvePath = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

/**
 * 头部截断（对应 pi 的 truncate.ts）：先按行数截，再按字节截，超出时追加说明。
 * 防止 cat 大文件、长跑命令输出等内容撑爆模型上下文窗口。
 */
function truncate(text: string): string {
  const lines = text.split("\n");
  let out = lines.slice(0, MAX_LINES).join("\n");
  let note = lines.length > MAX_LINES ? `\n... [truncated: showing ${MAX_LINES} of ${lines.length} lines]` : "";
  if (Buffer.byteLength(out) > MAX_BYTES) {
    out = Buffer.from(out).subarray(0, MAX_BYTES).toString("utf8");
    note = `\n... [truncated: output exceeded ${MAX_BYTES / 1024}KB]`;
  }
  return out + note;
}

/**
 * 工具分发与实现。返回值即 tool_result 的内容；抛出的异常会在 agentTurn 里
 * 被捕获并转成 is_error=true 的 tool_result 回灌给模型（模型通常能据此自我纠正）。
 */
async function runTool(name: string, input: any): Promise<string> {
  switch (name) {
    case "read": {
      // 读全文 → 按 offset/limit 切片 → 加 cat -n 风格行号（右对齐 6 位 + 制表符）
      // Number() 兜底：模型偶尔会把数字参数传成字符串
      const all = (await readFile(resolvePath(String(input.path)), "utf8")).split("\n");
      const offset = Math.max(1, Number(input.offset) || 1);
      const limit = Number(input.limit) || undefined;
      const slice = all.slice(offset - 1, limit ? offset - 1 + limit : undefined);
      const numbered = slice.map((l, i) => `${String(offset + i).padStart(6)}\t${l}`).join("\n");
      return truncate(numbered || `(empty file, or offset ${offset} past end of file)`);
    }
    case "write": {
      const p = resolvePath(String(input.path));
      await mkdir(dirname(p), { recursive: true }); // 父目录自动创建（pi 同款行为）
      await writeFile(p, String(input.content), "utf8");
      return `wrote ${Buffer.byteLength(String(input.content))} bytes to ${input.path}`;
    }
    case "edit": {
      const p = resolvePath(String(input.path));
      const original = await readFile(p, "utf8");
      if (!Array.isArray(input.edits) || input.edits.length === 0) throw new Error("edits must be a non-empty array");
      // 先在「原文件」上统一校验所有 oldText：不存在 → 报错；出现多次 → 报错。
      // 全部通过后再统一应用，避免改了一半留下半成品文件（pi 的同款策略）。
      for (const e of input.edits) {
        const n = original.split(e.oldText).length - 1; // 用 split 计数，无需转义正则
        if (n === 0) throw new Error(`oldText not found in ${input.path}: ${JSON.stringify(String(e.oldText).slice(0, 80))}`);
        if (n > 1) throw new Error(`oldText occurs ${n} times in ${input.path}; it must be unique`);
      }
      let next = original;
      for (const e of input.edits) next = next.replace(e.oldText, e.newText); // replace 只替换第一处，已校验唯一
      await writeFile(p, next, "utf8");
      return `applied ${input.edits.length} edit(s) to ${input.path}`;
    }
    case "bash":
      return new Promise((done) => {
        // spawn + shell:true 走系统 shell（支持管道、重定向等）；
        // timeout 到期后 Node 自动向进程发 SIGTERM
        const child = spawn(String(input.command), {
          shell: true,
          timeout: input.timeout ? Number(input.timeout) * 1000 : undefined,
        });
        let out = "";
        // stdout/stderr 合并收集：模型通常不关心分流，合并更省上下文
        child.stdout?.on("data", (d) => (out += d));
        child.stderr?.on("data", (d) => (out += d));
        child.on("error", (e) => done(`Error: ${e.message}`));
        child.on("close", (code, signal) => {
          // 附上退出码 / 被信号杀死的标记，帮助模型判断命令成败
          let tail = code ? `\n[exit code ${code}]` : "";
          if (signal) tail += `\n[killed by ${signal}${input.timeout ? " (timeout)" : ""}]`;
          done((truncate(out.trimEnd()) || "(no output)") + tail);
        });
      });
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ====================================================== 双协议 SSE 流式调用
type LlmResult = { content: Block[]; stopReason: string; usage: { input: number; output: number } };

/**
 * 通用 SSE 帧解析（两条协议共用）：逐帧吐出 data 载荷的 JSON。
 * SSE 协议：事件之间以空行(\n\n)分隔，数据行形如 "data: {json}"；
 * 一个事件可能跨多个 TCP 包，用 sse 缓冲区接住不完整的一帧，等下一轮拼齐。
 */
async function* sseJson(res: Response): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let sse = "";
  for await (const chunk of res.body as any) {
    sse += decoder.decode(chunk as Uint8Array, { stream: true });
    const events = sse.split("\n\n");
    sse = events.pop()!; // 最后一段是不完整事件，留到下次拼接
    for (const raw of events)
      for (const line of raw.split("\n"))
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data && data !== "[DONE]") yield JSON.parse(data);
        }
  }
}

/** 协议分发：agent 循环只面对统一的 LlmResult，不关心底层是哪种协议 */
function callLLM(messages: Message[], onText: (delta: string) => void): Promise<LlmResult> {
  return provider.protocol === "anthropic" ? callAnthropic(messages, onText) : callOpenAI(messages, onText);
}

/**
 * Anthropic Messages API（stream:true）。
 * - onText 回调把文本增量实时打到终端（流式体验的核心）
 * - tool_use 的参数以 input_json_delta 分片下发，按块下标累积后一次性 JSON.parse
 * - 返回：完整 assistant 内容块 + stop_reason + token 用量
 */
async function callAnthropic(messages: Message[], onText: (delta: string) => void): Promise<LlmResult> {
  const res = await fetch(`${provider.baseURL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(provider.auth === "bearer" ? { authorization: `Bearer ${provider.apiKey}` } : { "x-api-key": provider.apiKey! }),
    },
    body: JSON.stringify({ model: provider.model, max_tokens: 16384, stream: true, system: SYSTEM_PROMPT, messages, tools: TOOLS }),
  });
  if (!res.ok || !res.body) throw new Error(`API error ${res.status}: ${await res.text()}`);

  // content 按 content_block 的 index 存放；端点若返回 thinking 等未处理块会留下空洞，
  // 最后统一 filter(Boolean) 丢弃（本 agent 不开启 thinking，丢弃是安全兜底）
  const content: Block[] = [];
  const jsonBuf: string[] = []; // 按块下标累积 tool_use 参数的 partial_json 分片
  let stopReason = "end_turn";
  const usage = { input: 0, output: 0 };

  for await (const ev of sseJson(res)) {
    switch (ev.type) {
      case "message_start": // 消息开始：携带输入 token 数
        usage.input = ev.message?.usage?.input_tokens ?? 0;
        break;
      case "content_block_start": // 内容块开始：text 建空文本块；tool_use 建调用块并开始累积参数
        if (ev.content_block.type === "text") content[ev.index] = { type: "text", text: "" };
        else if (ev.content_block.type === "tool_use") {
          content[ev.index] = { type: "tool_use", id: ev.content_block.id, name: ev.content_block.name, input: {} };
          jsonBuf[ev.index] = "";
        }
        break;
      case "content_block_delta": // 增量：文本 → 追加并回调打印；工具参数 → 累积 JSON 分片
        if (ev.delta.type === "text_delta") {
          (content[ev.index] as TextBlock).text += ev.delta.text;
          onText(ev.delta.text);
        } else if (ev.delta.type === "input_json_delta") jsonBuf[ev.index] += ev.delta.partial_json;
        break;
      case "content_block_stop": {
        // 块结束：把累积的工具参数 JSON 一次性解析（解析失败兜底为空对象）
        const b = content[ev.index];
        if (b?.type === "tool_use") {
          try {
            b.input = JSON.parse(jsonBuf[ev.index] || "{}");
          } catch {
            b.input = {};
          }
        }
        break;
      }
      case "message_delta": // 收尾：stop_reason（end_turn / tool_use / max_tokens）与输出 token 数
        stopReason = ev.delta?.stop_reason ?? stopReason;
        usage.output = ev.usage?.output_tokens ?? usage.output;
        break;
      case "error":
        throw new Error(`API stream error: ${ev.error?.message ?? JSON.stringify(ev)}`);
    }
  }
  return { content: content.filter(Boolean), stopReason, usage };
}

/**
 * OpenAI chat/completions 兼容协议（DeepSeek 官方 API 等）。
 * 在收发边界做格式转换，内部仍是统一的 Block[]：
 * - 发出：system 提示词 → 首条 system 消息；assistant 的 tool_use → tool_calls 数组
 *   （arguments 是 JSON 字符串）；每个 tool_result → 一条独立的 role:"tool" 消息
 * - 收回：delta.content 是文本增量；delta.tool_calls 按 index 累积
 *   （id/name 只出现在首个分片，arguments 逐片拼接）；
 *   finish_reason "length" 映射为 max_tokens，复用 agentTurn 的截断保护
 */
async function callOpenAI(messages: Message[], onText: (delta: string) => void): Promise<LlmResult> {
  // ---- 1) 消息转换：内部 Block[] → OpenAI chat 格式
  const oaiMessages: any[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      oaiMessages.push({ role: m.role, content: m.content });
    } else if (m.role === "assistant") {
      const text = m.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("");
      const toolCalls = m.content.filter((b): b is ToolUse => b.type === "tool_use").map((tu) => ({
        id: tu.id, type: "function", function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
      }));
      oaiMessages.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else {
      // user 角色此时只会是 tool_result 块数组：每个结果一条独立的 tool 消息
      for (const tr of m.content)
        if (tr.type === "tool_result") oaiMessages.push({ role: "tool", tool_call_id: tr.tool_use_id, content: tr.content });
    }
  }
  const res = await fetch(`${provider.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 8192,
      stream: true,
      stream_options: { include_usage: true }, // 让最后一个分片携带 token 用量
      messages: oaiMessages,
      tools: TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`API error ${res.status}: ${await res.text()}`);

  // ---- 2) 流式累积
  let text = "";
  const calls: Record<number, { id: string; name: string; args: string }> = {};
  let stopReason = "end_turn";
  const usage = { input: 0, output: 0 };
  for await (const ev of sseJson(res)) {
    if (ev.usage) {
      usage.input = ev.usage.prompt_tokens ?? usage.input;
      usage.output = ev.usage.completion_tokens ?? usage.output;
    }
    const choice = ev.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      onText(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const c = (calls[tc.index] ??= { id: "", name: "", args: "" });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name = tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
    }
    if (choice.finish_reason) stopReason = choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason;
  }

  // ---- 3) 组装回内部 Block[]（text 在前，tool_use 按 index 顺序）
  const content: Block[] = [];
  if (text) content.push({ type: "text", text });
  for (const c of Object.values(calls)) {
    let input: any = {};
    try {
      input = JSON.parse(c.args || "{}");
    } catch {
      /* 参数 JSON 不完整时兜底为空对象 */
    }
    content.push({ type: "tool_use", id: c.id, name: c.name, input });
  }
  return { content, stopReason, usage };
}

// ============================================================ agent 主循环
// -------- 终端渲染辅助：ANSI 颜色；非 TTY（管道/重定向）时退化为纯文本
const TTY = process.stdout.isTTY;
const paint = (code: string, s: string) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => paint("2", s);
const cyan = (s: string) => paint("36", s);
const red = (s: string) => paint("31", s);

/** 把工具调用参数压成一行摘要，便于扫读（bash 取命令、read 带分页区间……） */
function summarize(tu: ToolUse): string {
  const i = tu.input ?? {};
  switch (tu.name) {
    case "read":
      return `${i.path}${i.offset ? `:${i.offset}` : ""}${i.limit ? `,${i.limit}` : ""}`;
    case "write":
      return `${i.path} (${Buffer.byteLength(String(i.content ?? ""))} bytes)`;
    case "edit":
      return `${i.path} (${Array.isArray(i.edits) ? i.edits.length : "?"} edit(s))`;
    case "bash":
      return String(i.command ?? "").replace(/\s+/g, " ").slice(0, 120);
    default:
      return JSON.stringify(i).slice(0, 120);
  }
}

/** 工具结果只预览前 5 行（完整内容进模型上下文，但不刷屏）；错误用红色醒目显示 */
function printResult(out: string, isError: boolean) {
  const lines = out.split("\n");
  const head = lines.slice(0, 5).map((l) => "  " + l);
  if (lines.length > 5) head.push(`  … (${lines.length - 5} more lines)`);
  console.log((isError ? red : dim)(head.join("\n")));
}

/**
 * 处理一轮用户输入的完整 agent 循环（对应 pi 的 agentLoop）：
 *   流式请求 LLM → 收集 tool_use → 顺序执行 → tool_result 回灌 → 再次请求 …
 * 直到响应里没有工具调用（end_turn）或触发 MAX_TURNS 保险丝。
 * 整个 agent 的唯一状态就是 messages 数组 —— 这是 pi 极简设计的核心。
 */
async function agentTurn(messages: Message[]): Promise<void> {
  for (let turn = 0; ; turn++) {
    if (turn >= MAX_TURNS) {
      console.log(red(`\n[stopped: reached max ${MAX_TURNS} turns]`));
      return;
    }
    // 请求 LLM；文本增量直接流式打印（协议细节在 callLLM 里，这里无感知）
    const res = await callLLM(messages, (d) => process.stdout.write(d));
    messages.push({ role: "assistant", content: res.content });
    const toolUses = res.content.filter((b): b is ToolUse => b.type === "tool_use");
    if (toolUses.length === 0) break; // 没有工具调用 → 本轮结束

    const results: ToolResult[] = [];
    for (const tu of toolUses) {
      console.log(`\n${cyan("→ " + tu.name)} ${dim(summarize(tu))}`);
      let out: string, isError = false;
      // pi 的关键保护：响应被 max_tokens 截断时，流式累积的工具参数可能是不完整的
      // JSON，执行有风险 —— 一律以错误回灌，让模型重新发起一次完整的工具调用
      if (res.stopReason === "max_tokens") {
        out = "Error: response hit the output token limit, so tool call arguments may be truncated. Re-issue the tool call with complete arguments.";
        isError = true;
      } else {
        try {
          out = await runTool(tu.name, tu.input);
        } catch (e) {
          out = `Error: ${e instanceof Error ? e.message : String(e)}`;
          isError = true;
        }
      }
      printResult(out, isError);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: out, is_error: isError });
    }
    // tool_result 以 role:"user" 消息回灌（内部统一格式；OpenAI 路径发送时再转换）
    messages.push({ role: "user", content: results });
    console.log(dim(`  · tokens: ${res.usage.input} in / ${res.usage.output} out`));
  }
}

// ==================================================================== REPL
/**
 * 交互式多轮对话。用 for-await 异步迭代 readline，而不是 rl.question：
 * 管道输入（printf "..." | node agent.ts）时所有行一次性到达，question 模式
 * 会在 stdin EOF 关闭 readline 时丢弃缓冲行，下一轮 question 直接抛
 * ERR_USE_AFTER_CLOSE；异步迭代则会把缓冲行逐条吐完再正常结束。
 *
 * 斜杠命令：/clear 清空上下文；/model 查看或切换 provider/模型；/exit 退出
 */
async function repl(messages: Message[]): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(cyan("\n> "));
  console.log(dim(`ti — minimal pi-style agent | ${provider.name}:${provider.model} | ${process.cwd()}`));
  console.log(dim("/clear reset · /model [name] switch · /exit quit"));
  let closed = false;
  rl.once("close", () => {
    closed = true; // 管道场景下 rl 会提前 close，但缓冲行仍可继续迭代
  });
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === "/exit" || line === "/quit") break;
    if (line === "/clear") {
      messages.length = 0; // 清空对话状态（唯一状态就是 messages 数组）
      console.log(dim("(context cleared)"));
    } else if (line === "/model" || line.startsWith("/model ")) {
      // /model 切换：参数是 provider 名 → 重新解析该 provider（连带其默认模型）；
      // 其他名字 → 仅换当前 provider 下的模型。历史消息是协议无关的 Block[]，跨 provider 无缝
      const arg = line.slice(6).trim();
      try {
        if (!arg) console.log(dim(`provider: ${provider.name} | model: ${provider.model} | ${provider.baseURL}`));
        else if (PRESETS[arg] || settings.providers?.[arg]) {
          provider = resolveProvider(arg);
          console.log(dim(`switched → ${provider.name}:${provider.model}`));
        } else {
          provider = { ...provider, model: arg };
          console.log(dim(`model → ${provider.model} (provider ${provider.name})`));
        }
      } catch (e) {
        console.error(red(`error: ${e instanceof Error ? e.message : String(e)}`));
      }
    } else if (line) {
      messages.push({ role: "user", content: line });
      try {
        await agentTurn(messages);
      } catch (e) {
        messages.pop(); // 请求失败时弹出未应答的用户消息，保持消息历史合法
        console.error(red(`error: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
    if (!closed) rl.prompt(); // rl 已关闭时 prompt() 会抛 ERR_USE_AFTER_CLOSE
  }
  rl.close();
}

// ==================================================================== 入口
// 构建系统提示词 → 带 prompt 走单发模式，否则进 REPL 多轮对话
const SYSTEM_PROMPT = await buildSystemPrompt();
const messages: Message[] = [];
if (prompt !== undefined) {
  // 单发模式：跑完一轮即退出；异常时以非零码结束，方便脚本/CI 集成
  messages.push({ role: "user", content: prompt });
  try {
    await agentTurn(messages);
  } catch (e) {
    console.error(red(`\nerror: ${e instanceof Error ? e.message : String(e)}`));
    process.exitCode = 1;
  }
  console.log();
} else {
  await repl(messages);
}
