/**
 * 交互式多轮对话（REPL）。用 for-await 异步迭代 readline，而不是 rl.question：
 * 管道输入（printf "..." | node src/main.ts）时所有行一次性到达，question 模式
 * 会在 stdin EOF 关闭 readline 时丢弃缓冲行，下一轮 question 直接抛
 * ERR_USE_AFTER_CLOSE；异步迭代则会把缓冲行逐条吐完再正常结束。
 *
 * 斜杠命令：/clear 清空上下文；/model 查看或切换 provider/模型；/exit 退出
 */
import { createInterface } from "node:readline";
import type { Message } from "../types.ts";
import { getProvider, setProvider, resolveProvider, PRESETS, settings } from "../config/index.ts";
import { agentTurn, type AgentContext } from "../core/agent.ts";
import { cyan, dim, red } from "./render.ts";

export async function repl(messages: Message[], ctx: AgentContext): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(cyan("\n> "));
  const provider = getProvider();
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
      // 其他名字 → 仅换当前 provider 下的模型。历史消息是协议无关的自定义格式，跨 provider 无缝
      const arg = line.slice(6).trim();
      try {
        if (!arg) {
          const p = getProvider();
          const models = PRESETS[p.name]?.models?.map((m) => m.id).join(", ");
          console.log(dim(`provider: ${p.name} | model: ${p.model} | ${p.baseURL}`));
          if (models) console.log(dim(`models: ${models}`));
        } else if (PRESETS[arg] || settings.providers?.[arg]) {
          setProvider(resolveProvider(arg));
          const p = getProvider();
          console.log(dim(`switched → ${p.name}:${p.model}`));
        } else {
          setProvider({ ...getProvider(), model: arg });
          const p = getProvider();
          console.log(dim(`model → ${p.model} (provider ${p.name})`));
        }
      } catch (e) {
        console.error(red(`error: ${e instanceof Error ? e.message : String(e)}`));
      }
    } else if (line) {
      messages.push({ role: "user", content: line });
      try {
        await agentTurn(messages, ctx);
      } catch (e) {
        messages.pop(); // 请求失败时弹出未应答的用户消息，保持消息历史合法
        console.error(red(`error: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
    if (!closed) rl.prompt(); // rl 已关闭时 prompt() 会抛 ERR_USE_AFTER_CLOSE
  }
  rl.close();
}
