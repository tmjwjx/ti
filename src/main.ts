// 入口。扫命令行 → 缺配置则走指引 → 进 REPL
// 本文件不跑模型、不跑工具
import type { Message } from "./types.ts";
import { isProviderReady, resolveProvider, setProvider, settings } from "./config/index.ts";
import { buildSystemPrompt } from "./core/prompt.ts";
import { loadSkills } from "./core/skills.ts";
import { createTerminalUI } from "./cli/render.ts";
import { commandNames, pickAndResume, repl } from "./cli/repl.ts";
import { openTui } from "./cli/tui.ts";
import type { Tui } from "./cli/tui.ts";
import { FormAbort } from "./cli/form.ts";
import { runSetup } from "./cli/setup.ts";
import { runUpdate } from "./cli/update.ts";
import { VERSION } from "./version.ts";

// 打印用法并退出
function help(code: number): never {
  console.log(`ti ${VERSION}
usage: ti [setup | update] [--provider name] [-m model] [--resume]
  setup            configure provider, model, and API key
  update           install the latest version
  -m, --model      model name
      --provider   deepseek | kimi | glm | custom names from settings.json
      --resume     pick a session from this directory
  -v, --version    print version
config: ~/.ti/settings.json`);
  process.exit(code);
}

// 是不是交互终端
function isTty(): boolean {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

// 解开 TUI 再结束进程
function quit(tui: Tui | undefined, code: number): never {
  tui?.close();
  process.exit(code);
}

// 缺配置时走指引
async function maybeSetup(force: boolean, tui?: Tui): Promise<void> {
  const name = settings.provider;
  if (!force && isProviderReady(name)) return;
  if (!isTty()) {
    console.error("error: no usable config — run ti in a terminal");
    quit(tui, 1);
  }
  try {
    const r = await runSetup(tui);
    // `ti setup` 取消且本来就能用：正常退出。冷启动取消：失败
    if (r !== "saved") quit(tui, force && isProviderReady(settings.provider) ? 0 : 1);
  } catch (e) {
    if (e instanceof FormAbort) quit(tui, 1);
    throw e;
  }
}

// 启动
async function main() {
  let forceSetup = false;
  let cliProvider: string | undefined;
  let cliModel: string | undefined;
  let resume = false;
  const args = process.argv.slice(2);
  if (args.includes("update")) {
    if (args.length !== 1) help(1);
    await runUpdate();
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "setup") forceSetup = true;
    else if (a === "--provider" && args[i + 1]) cliProvider = args[++i]; // ++i 吃掉下一个参数当值
    else if ((a === "-m" || a === "--model") && args[i + 1]) cliModel = args[++i];
    else if (a === "--resume") resume = true;
    else if (a === "-h" || a === "--help") help(0);
    else if (a === "-v" || a === "--version") {
      console.log(VERSION);
      process.exit(0);
    }
    else {
      console.error(`error: unknown argument ${a}`);
      help(1);
    }
  }

  const tui = isTty() ? openTui() : undefined;
  try {
    await maybeSetup(forceSetup, tui);

    try {
      setProvider(resolveProvider(cliProvider ?? settings.provider, cliModel));
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      quit(tui, 1);
    }

    // 只扫这一次。系统提示词整个进程不变，新加的 skill 要重启
    const skills = loadSkills(commandNames());
    const systemPrompt = await buildSystemPrompt(skills);
    const messages: Message[] = [];
    // 厂家已经定了再挑会话。恢复不切 provider，meta 里的只是当时记录
    if (resume) {
      const say = tui ? (s: string) => tui.writeln(s) : (s: string) => console.log(s);
      await pickAndResume(messages, say, tui);
    }
    if (tui) {
      await repl(messages, { systemPrompt, ui: createTerminalUI(tui) }, skills, tui);
    } else {
      await repl(messages, { systemPrompt, ui: createTerminalUI() }, skills);
    }
  } finally {
    tui?.close();
  }
  // raw 模式退出后显式 exit，避免 stdin 还 resume 着把进程挂住
  if (tui) quit(tui, 0);
}

await main();
