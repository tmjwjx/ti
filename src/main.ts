/**
 * 入口：解析 CLI → 装配 → 单发或 REPL。
 */
import type { Message } from "./types.ts";
import { resolveProvider, setProvider, settings } from "./config/index.ts";
import { buildSystemPrompt } from "./core/prompt.ts";
import { agentTurn, type AgentContext } from "./core/agent.ts";
import { createTerminalUI, red } from "./cli/render.ts";
import { repl } from "./cli/repl.ts";

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

function help(code: number): never {
  console.log(`ti
usage: ti [--provider name] [-m model] [-p prompt | prompt words...]
  -p, --prompt     run a single prompt non-interactively (default: interactive REPL)
  -m, --model      model name (overrides settings.json / preset default)
      --provider   provider: deepseek (default) | anthropic | custom names from settings.json
config: ~/.ti/settings.json — { "provider": "deepseek", "providers": { "<name>": { "baseURL", "model", "apiKey" } } }`);
  process.exit(code);
}

try {
  setProvider(resolveProvider(cliProvider ?? settings.provider ?? "deepseek", cliModel));
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
const ctx: AgentContext = { systemPrompt: await buildSystemPrompt(), ui: createTerminalUI() };

const messages: Message[] = [];
if (prompt !== undefined) {
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
