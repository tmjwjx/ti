/**
 * REPL（Read-Eval-Print Loop）：读一行、执行、打印结果、再打提示符，循环直到退出。
 * 本文件就是这个循环。斜杠命令自己处理，其它非空行交给 agentTurn。
 * /clear 清空历史；/model 查看或切换模型；/provider 查看或切换厂家；/exit 退出。
 */
import { createInterface } from "node:readline";
import type { Message } from "../types.ts";
import { getProvider, setProvider, resolveProvider, PRESETS, settings } from "../config/index.ts";
import { agentTurn, type AgentContext } from "../core/agent.ts";
import { cyan, dim, red } from "./render.ts";

function providerNames(): string[] {
  return [...new Set([...Object.keys(PRESETS), ...Object.keys(settings.providers ?? {})])];
}

export async function repl(messages: Message[], ctx: AgentContext): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(cyan("\n> "));
  const provider = getProvider();
  console.log(dim(`${provider.name}:${provider.model}  ${process.cwd()}`));
  console.log(dim("/clear · /model [id] · /provider [name] · /exit"));
  // 管道场景下 stdin 结束时 rl 会先 close，但 for-await 可能还在吐缓冲行
  let closed = false;
  rl.once("close", () => {
    closed = true;
  });
  rl.prompt();
  // 按行迭代，不用 question：管道输入时行一次到齐、stdin 立刻 EOF，
  // question 会丢缓冲并抛 ERR_USE_AFTER_CLOSE；这里能把已到的行吐完。
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === "/exit" || line === "/quit") break;
    if (line === "/clear") {
      messages.length = 0;
      console.log(dim("(context cleared)"));
    } else if (line === "/model" || line.startsWith("/model ")) {
      const arg = line.slice(6).trim();
      const p = getProvider();
      if (!arg) {
        const models = (settings.providers?.[p.name]?.models ?? PRESETS[p.name]?.models ?? [])
          .map((m: { id: string }) => m.id)
          .join(", ");
        console.log(dim(`model: ${p.model}`));
        if (models) console.log(dim(`models: ${models}`));
      } else {
        setProvider({ ...p, model: arg });
        console.log(dim(`model → ${arg}`));
      }
    } else if (line === "/provider" || line.startsWith("/provider ")) {
      const arg = line.slice(10).trim();
      try {
        if (!arg) {
          const cur = getProvider().name;
          for (const name of providerNames()) {
            const file = settings.providers?.[name] ?? {};
            const preset = PRESETS[name];
            const proto = file.protocol ?? preset?.protocol ?? "?";
            const model = file.model ?? preset?.models?.[0]?.id ?? "";
            const base = (file.baseURL ?? preset?.baseURL ?? "").replace(/\/+$/, "");
            console.log(dim(`${name === cur ? "* " : "  "}${name}  ${proto}  ${model}  ${base}`));
          }
        } else {
          setProvider(resolveProvider(arg));
          const p = getProvider();
          console.log(dim(`provider → ${p.name}:${p.model}`));
        }
      } catch (e) {
        console.error(red(`error: ${e instanceof Error ? e.message : String(e)}`));
      }
    } else if (line) {
      messages.push({ role: "user", content: line });
      try {
        await agentTurn(messages, ctx);
      } catch (e) {
        messages.pop();
        console.error(red(`error: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
    if (!closed) rl.prompt();
  }
  rl.close();
}
