// 读一行、执行、再提示
import { createInterface } from "node:readline";
import type { Message } from "../types.ts";
import {
  CATALOG,
  getProvider,
  setProvider,
  resolveProvider,
  listModels,
  listProviderNames,
  writeProvider,
  settings,
  saveSettings,
} from "../config/index.ts";
import { agentTurn, type AgentContext } from "../core/agent.ts";
import { dim, red } from "./render.ts";
import type { Tui } from "./tui.ts";
import { FormAbort, select } from "./form.ts";
import { runSetup } from "./setup.ts";

type Say = (s: string) => void;

export const COMMANDS = [
  { name: "/clear", hint: "clear conversation" },
  { name: "/model", hint: "switch configured model" },
  { name: "/provider", hint: "switch configured provider" },
  { name: "/setup", hint: "add or edit provider" },
  { name: "/cost", hint: "token usage" },
  { name: "/help", hint: "list commands" },
  { name: "/exit", hint: "quit" },
];

// 千分位
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

// 会话里的 token 合计
function tokenTotals(messages: Message[]): { input: number; output: number; turns: number } {
  let input = 0;
  let output = 0;
  let turns = 0;
  for (const m of messages) {
    if (m.role === "assistant") {
      input += m.usage.input;
      output += m.usage.output;
      turns += 1;
    }
  }
  return { input, output, turns };
}

// 路径里的家目录收成 ~
function shortHome(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

let lastTurn = { input: 0, output: 0 };

// 底栏文案
function footerText(messages: Message[]): string {
  const p = getProvider();
  const t = tokenTotals(messages);
  const parts = [`${p.name}:${p.model}`, shortHome(process.cwd())];
  if (lastTurn.input || lastTurn.output) parts.push(`turn ${fmt(lastTurn.input)}↑ ${fmt(lastTurn.output)}↓`);
  if (t.turns) parts.push(`session ${fmt(t.input)}↑ ${fmt(t.output)}↓`);
  return parts.join("  ·  ");
}

// 跑一轮全屏 form
async function withForm<T>(tui: Tui | undefined, fn: () => Promise<T>): Promise<T | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  tui?.pause();
  try {
    return await fn();
  } catch (e) {
    if (e instanceof FormAbort) return undefined;
    throw e;
  } finally {
    tui?.resume();
  }
}

// /model 二级列表
function modelItems() {
  const p = getProvider();
  return listModels(p.name).map((id) => ({
    name: `/model ${id}`,
    label: id,
    hint: id === p.model ? "current" : "",
    current: id === p.model,
  }));
}

// /provider 二级列表
function providerItems() {
  const cur = getProvider().name;
  return listProviderNames().map((n) => ({
    name: `/provider ${n}`,
    label: CATALOG[n]?.label ?? n,
    hint: n === cur ? "current" : n,
    current: n === cur,
  }));
}

// 按已输入过滤列表
function filterItems(items: { name: string; label?: string; hint: string }[], q: string) {
  if (!q) return items;
  const n = q.toLowerCase();
  return items.filter((it) => (it.label ?? it.name).toLowerCase().includes(n) || it.name.toLowerCase().includes(n));
}

// 无参时切模型
async function pickModel(say: Say, tui?: Tui): Promise<void> {
  const p = getProvider();
  const ids = listModels(p.name);
  if (tui) {
    if (ids.length) say(dim(`models: ${ids.join(", ")}`));
    else say(dim("no models"));
    return;
  }
  const picked = await withForm(undefined, () =>
    select(
      "Model",
      ids.map((id) => ({ value: id, label: id })),
      Math.max(0, ids.indexOf(p.model)),
    ),
  );
  if (picked === undefined) {
    if (!process.stdin.isTTY) {
      say(dim(`model: ${p.model}`));
      if (ids.length) say(dim(`models: ${ids.join(", ")}`));
    }
    return;
  }
  writeProvider(p.name, { model: picked });
  setProvider(resolveProvider(p.name, picked));
  say(dim(`model → ${picked}`));
}

// 无参时切厂家
async function pickProvider(say: Say, tui?: Tui): Promise<void> {
  const names = listProviderNames();
  const cur = getProvider().name;
  if (tui) {
    if (names.length) say(dim(`providers: ${names.join(", ")}`));
    else say(dim("no providers"));
    return;
  }
  const picked = await withForm(undefined, () =>
    select(
      "Provider",
      names.map((n) => ({ value: n, label: CATALOG[n]?.label ?? n })),
      Math.max(0, names.indexOf(cur)),
    ),
  );
  if (picked === undefined) {
    if (!process.stdin.isTTY) {
      for (const n of names) say(dim(`${n === cur ? "* " : "  "}${n}`));
    }
    return;
  }
  applyProvider(picked, say);
}

// 切换当前厂家
function applyProvider(name: string, say: Say) {
  try {
    const p = resolveProvider(name);
    settings.provider = name;
    saveSettings();
    setProvider(p);
    say(dim(`provider → ${p.name}:${p.model}`));
  } catch (e) {
    say(red(`error: ${e instanceof Error ? e.message : String(e)}`));
  }
}

// 执行一行输入
async function dispatch(
  line: string,
  messages: Message[],
  ctx: AgentContext,
  say: Say,
  tui?: Tui,
  signal?: AbortSignal,
): Promise<"exit" | "cont"> {
  if (line === "/exit" || line === "/quit") return "exit";
  if (line === "/help") {
    for (const c of COMMANDS) say(dim(`${c.name.padEnd(12)} ${c.hint}`));
    return "cont";
  }
  if (line === "/cost") {
    const t = tokenTotals(messages);
    const turn = lastTurn.input || lastTurn.output ? ` · last turn ${fmt(lastTurn.input)} in / ${fmt(lastTurn.output)} out` : "";
    say(dim(`session  ${fmt(t.input)} in · ${fmt(t.output)} out · ${t.turns} calls${turn}`));
    return "cont";
  }
  if (line === "/clear") {
    messages.length = 0; // 就地清空，调用方拿的还是同一份数组。
    lastTurn = { input: 0, output: 0 };
    tui?.clear();
    say(dim("(context cleared)"));
    return "cont";
  }
  if (line === "/setup") {
    let r: "saved" | "cancel" | undefined;
    try {
      r = await runSetup(tui);
    } catch (e) {
      // 非 TUI 走 form 时 Ctrl+C 会 throw；TUI pick 与 ask 只返回 undefined
      if (!(e instanceof FormAbort)) throw e;
    }
    if (r === "saved" && settings.provider) {
      try {
        setProvider(resolveProvider(settings.provider));
        say(dim(`provider → ${getProvider().name}:${getProvider().model}`));
      } catch (e) {
        say(red(`error: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
    return "cont";
  }
  if (line === "/model" || line.startsWith("/model ")) {
    const arg = line.slice(6).trim(); // "/model".length === 6，后面才是 id
    if (!arg) await pickModel(say, tui);
    else {
      const p = getProvider();
      if (!listModels(p.name).includes(arg)) {
        // /model 只切已写入的；新模型走 /setup，避免随口一个 id 写进 settings
        say(dim(`unknown model ${arg}  ·  /setup to add`));
        return "cont";
      }
      writeProvider(p.name, { model: arg });
      setProvider(resolveProvider(p.name, arg));
      say(dim(`model → ${arg}`));
    }
    return "cont";
  }
  if (line === "/provider" || line.startsWith("/provider ")) {
    const arg = line.slice(10).trim();
    if (!arg) await pickProvider(say, tui);
    else applyProvider(arg, say);
    return "cont";
  }
  if (line.startsWith("/")) {
    say(dim(`unknown command ${line.split(/\s/)[0]}  ·  type / for the list`));
    return "cont";
  }
  if (!line) return "cont";
  messages.push({ role: "user", content: line });
  // 用差值算「这一轮」token，footer 的 turn 才不会被历史冲掉
  const before = tokenTotals(messages);
  try {
    await agentTurn(messages, { ...ctx, signal });
    const after = tokenTotals(messages);
    const din = after.input - before.input;
    const dout = after.output - before.output;
    if (din || dout) lastTurn = { input: din, output: dout };
    say("");
  } catch (e) {
    // 请求失败这条 user 没被模型看见，拿掉以免脏历史。abort 不会到这里
    messages.pop();
    say(red(`error: ${e instanceof Error ? e.message : String(e)}`));
  }
  return "cont";
}

// 读一行再执行
export async function repl(messages: Message[], ctx: AgentContext, tui?: Tui): Promise<void> {
  if (tui) {
    tui.setCommands(COMMANDS);
    // /model、/provider 换成二级选项，避免再 pause 出屏顶选择框
    tui.setLookup((input) => {
      if (input === "/model" || input.startsWith("/model ")) {
        return filterItems(modelItems(), input.slice(6).trim());
      }
      if (input === "/provider" || input.startsWith("/provider ")) {
        return filterItems(providerItems(), input.slice(10).trim());
      }
      return null; // 交给一级 / 列表；不要回 []，否则 /help 会被空列表盖住。
    });
    tui.setFooter(footerText(messages));
    let abort: AbortController | undefined;
    tui.onInterrupt(() => abort?.abort());
    while (true) {
      const raw = await tui.readLine();
      if (raw === null) break;
      const line = raw.trim();
      // 斜杠命令不 busy，避免 /model 时 footer 还写着 esc interrupt
      const chatting = !!line && !line.startsWith("/");
      abort = new AbortController();
      if (chatting) tui.setBusy(true);
      try {
        const r = await dispatch(line, messages, ctx, (s) => tui.writeln(s), tui, abort.signal);
        if (r === "exit") break;
      } finally {
        tui.setBusy(false);
        abort = undefined;
        tui.setFooter(footerText(messages));
      }
    }
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("\n> ");
  let closed = false;
  rl.once("close", () => {
    closed = true;
  });
  rl.prompt();
  // 管道里 stdin 先 close 时，for-await 可能还在吐缓冲行；关掉后不再 prompt
  for await (const raw of rl) {
    const r = await dispatch(raw.trim(), messages, ctx, (s) => console.log(s));
    if (r === "exit") break;
    if (!closed) rl.prompt();
  }
  rl.close();
}
