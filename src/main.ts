/**
 * ti —— 极简 coding agent，架构参考 pi
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
 * 零 npm 依赖：Node >= 22.18（原生 type-stripping 免 flag 直接运行 .ts）。
 *
 * 本文件是唯一入口（组合根）：CLI 参数解析 → 装配各层 → 单发/REPL 分发。
 * 文件架构（依赖只能由外向内，详见 docs/DESIGN.md §2）：
 *   cli/（接口层）→ core/（应用/领域层）→ llm/ + tools/ + config/（适配层）→ types.ts（纯类型）
 */
import type { Message } from "./types.ts";
import { resolveProvider, setProvider, settings } from "./config/index.ts";
import { buildSystemPrompt } from "./core/prompt.ts";
import { agentTurn, type AgentContext } from "./core/agent.ts";
import { createTerminalUI, red } from "./cli/render.ts";
import { repl } from "./cli/repl.ts";

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
usage: ti [--provider name] [-m model] [-p prompt | prompt words...]
  -p, --prompt     run a single prompt non-interactively (default: interactive REPL)
  -m, --model      model name (overrides env / config / preset default)
      --provider   provider: deepseek (default) | anthropic | custom names from settings.json
config: ~/.ti/settings.json — { "provider": "deepseek", "providers": { "<name>": { "baseURL", "model", "apiKey" } } }
env:    TI_PROVIDER / TI_MODEL / TI_BASE_URL
        DEEPSEEK_API_KEY (or OPENAI_API_KEY)      — for the openai protocol
        ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY — for the anthropic protocol`);
  process.exit(code);
}

// -------- 装配（组合根）
// 启动时解析一次 provider；REPL 里 /model 可随时切换（provider 是会话级可变状态，住 config/index.ts）
setProvider(resolveProvider(cliProvider ?? process.env.TI_PROVIDER ?? settings.provider ?? "deepseek", cliModel));
const ctx: AgentContext = { systemPrompt: await buildSystemPrompt(), ui: createTerminalUI() };

// -------- 分发：带 prompt 走单发模式，否则进 REPL 多轮对话
const messages: Message[] = [];
if (prompt !== undefined) {
  // 单发模式：跑完一轮即退出；异常时以非零码结束，方便脚本/CI 集成
  messages.push({ role: "user", content: prompt });
  try {
    await agentTurn(messages, ctx);
  } catch (e) {
    console.error(red(`\nerror: ${e instanceof Error ? e.message : String(e)}`));
    process.exitCode = 1;
  }
  console.log();
} else {
  await repl(messages, ctx);
}
