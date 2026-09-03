/**
 * 入口文件。node src/main.ts 打开本文件，最后一行调用 main()。
 * main 不是给操作系统找的，只是把启动步骤收在一个函数里。
 *
 * 顺序：扫命令行 → 选定厂家 → 拼 systemPrompt 和终端 UI → 有 prompt 单发一轮，否则进 REPL。
 * 本文件不跑模型、不跑工具，只装配，交给 agentTurn / repl。
 */
import type { Message } from "./types.ts";
import { ensureSettings, resolveProvider, setProvider, settings } from "./config/index.ts";
import { buildSystemPrompt } from "./core/prompt.ts";
import { agentTurn, type AgentContext } from "./core/agent.ts";
import { createTerminalUI, red } from "./cli/render.ts";
import { repl } from "./cli/repl.ts";

function help(code: number): never {
  console.log(`ti
usage: ti [--provider name] [-m model] [-p prompt | prompt words...]
  -p, --prompt     run a single prompt non-interactively (default: interactive REPL)
  -m, --model      model name (overrides settings.json / preset default)
      --provider   provider: deepseek (default) | custom names from settings.json
config: ~/.ti/settings.json — { "provider": "deepseek", "providers": { "<name>": { "baseURL", "model", "apiKey" } } }`);
  process.exit(code);
}

async function main() {
  // argv[0] 是 node，argv[1] 是本文件路径，从 [2] 起才是用户敲的参数
  let cliProvider: string | undefined; // 命令行参数 --provider 的值
  let cliModel: string | undefined; // 命令行参数 -m 或 --model 的值
  let prompt: string | undefined; // 命令行参数 -p 或 --prompt 的值
  const rest: string[] = []; // 命令行参数中除了 -p、-m、--provider 和 --help 之外的所有参数
  const args = process.argv.slice(2); 
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--provider" && args[i + 1]) cliProvider = args[++i];
    else if ((a === "-m" || a === "--model") && args[i + 1]) cliModel = args[++i];
    else if ((a === "-p" || a === "--prompt") && args[i + 1]) prompt = args[++i];
    else if (a === "-h" || a === "--help") help(0);
    else rest.push(a);
  }
  // -p 没写时，剩下的词拼成一句，也当单发；什么都不跟则 prompt 仍是 undefined，走 REPL
  prompt ??= rest.length ? rest.join(" ") : undefined;

  ensureSettings();
  // CLI 厂家 > settings.json 的 provider > 默认 deepseek；-m 再压过模型
  try {
    setProvider(resolveProvider(cliProvider ?? settings.provider ?? "deepseek", cliModel));
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // 一轮对话要用的两样：发给模型的系统提示词，以及往终端画的 UI
  const ctx: AgentContext = { systemPrompt: await buildSystemPrompt(), ui: createTerminalUI() };

  // messages 是整段对话的唯一状态，单发和 REPL 共用
  const messages: Message[] = [];
  if (prompt !== undefined) {
    messages.push({ role: "user", content: prompt });
    try {
      await agentTurn(messages, ctx);
    } catch (e) {
      console.error(red(`\nerror: ${e instanceof Error ? e.message : String(e)}`));
      process.exitCode = 1; // 给脚本/CI 用，不立刻 exit，好让后面的 console.log 打完
    }
    console.log();
  } else {
    await repl(messages, ctx);
  }
}

await main();
