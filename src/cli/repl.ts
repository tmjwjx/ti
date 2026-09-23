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
import { distrustUsage, resetTrust, runCompact, shouldAutoCompact } from "../core/compact.ts";
import { isContextOverflowError } from "../llm/index.ts";
import { readSkillBody, type Skill, type SkillSet } from "../core/skills.ts";
import {
  bindSession,
  endSession,
  inputText,
  isSessionPath,
  listSessions,
  loadMessages,
  openSession,
  popMessage,
  pushMessage,
  renameSession,
  sessionFile,
  sessionName,
  takePersistError,
  type SessionInfo,
} from "../core/session.ts";
import { dim, red, replayMessages } from "./render.ts";
import type { Tui } from "./tui.ts";
import { FormAbort, select } from "./form.ts";
import { runSetup } from "./setup.ts";

type Say = (s: string) => void;

export const COMMANDS = [
  { name: "/clear", hint: "clear conversation" },
  { name: "/compact", hint: "compact context" },
  { name: "/resume", hint: "resume a session in this directory" },
  { name: "/rename", hint: "rename this session" },
  { name: "/model", hint: "switch configured model" },
  { name: "/provider", hint: "switch configured provider" },
  { name: "/setup", hint: "add or edit provider" },
  { name: "/cost", hint: "token usage" },
  { name: "/skills", hint: "list skills" },
  { name: "/help", hint: "list commands" },
  { name: "/exit", hint: "quit" },
];

// 内置命令名（不带 /）。和它们同名的 skill 不能用 /名字 调
export function commandNames(): string[] {
  return [...COMMANDS.map((c) => c.name.slice(1)), "quit"];
}

// /名字 参数 里的 skill。内置命令已经在前面处理过，这里只剩能手动调的
function skillOf(line: string, skills: SkillSet): { skill: Skill; args: string } | undefined {
  if (!line.startsWith("/")) return undefined;
  const cut = line.search(/\s/);
  const name = (cut < 0 ? line : line.slice(0, cut)).slice(1);
  const skill = skills.skills.find((s) => s.invocable && s.name === name);
  if (!skill) return undefined;
  return { skill, args: cut < 0 ? "" : line.slice(cut).trim() };
}

// 命令列表里的 skill 项，排在内置命令后面
function skillCommands(skills: SkillSet) {
  return skills.skills
    .filter((s) => s.invocable)
    .map((s) => ({ name: `/${s.name}`, hint: s.description.replace(/\s+/g, " ").slice(0, 60) }));
}

// /skills：名字、来源、状态、描述，最后是警告
function printSkills(skills: SkillSet, say: Say): void {
  if (!skills.skills.length) {
    say(dim("no skills · put SKILL.md under .ti/skills/<name>/ or ~/.ti/skills/<name>/"));
  } else {
    const width = Math.min(24, Math.max(...skills.skills.map((s) => s.name.length)));
    for (const s of skills.skills) {
      const flags = [s.hidden ? "hidden" : "", !s.hidden && !s.listed ? "not listed" : "", s.invocable ? "" : "no command"]
        .filter(Boolean)
        .map((f) => `(${f}) `)
        .join("");
      const desc = s.description.replace(/\s+/g, " ").slice(0, 80);
      say(dim(`${s.name.padEnd(width)}  ${s.source.padEnd(7)}  ${flags}${desc}`));
    }
  }
  if (skills.warnings.length) {
    say("");
    say(dim("warnings"));
    for (const w of skills.warnings) say(dim(`  ${w}`));
  }
}

// 只在 TUI 的 /help 里打。管道没有这些键
const KEYS: [string, string][] = [
  ["enter", "send"],
  ["shift+enter", "newline (or \\ then enter)"],
  ["↑ / ↓", "history"],
  ["esc", "interrupt / back"],
  ["ctrl+c", "clear · interrupt · quit"],
  ["pageup/pagedown", "scroll"],
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
  return { input: input + carried.input, output: output + carried.output, turns };
}

// 路径里的家目录收成 ~
function shortHome(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

let lastTurn = { input: 0, output: 0 };
// 被压掉的用量加摘要请求自己的用量。压缩后那些 assistant 不在 messages 里了
let carried = { input: 0, output: 0 };

function addCarry(u: { input: number; output: number }): void {
  carried.input += u.input;
  carried.output += u.output;
}

function clearCarry(): void {
  carried = { input: 0, output: 0 };
}

function compactLine(before: number, after: number, auto: boolean): string {
  return `${auto ? "auto compacted" : "compacted"} · ${fmt(before)} → ${fmt(after)} tokens`;
}

// 列表里一项的显示
function sessionLabel(s: SessionInfo): string {
  const title = (s.name || "untitled").slice(0, 48);
  const d = new Date(s.mtime);
  const sameDay = d.toDateString() === new Date().toDateString();
  const when = sameDay
    ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("en-CA");
  return `${title}  ·  ${s.count} msgs  ·  ${when}`;
}

// 用户亲手打的话，skill 调用按 /名字 参数 还原。摘要和被打断的回复不在里面
function typedByUser(messages: Message[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    const text = inputText(m);
    if (text.trim()) out.push(text);
  }
  return out;
}

// 从当前目录挑一份会话并接上。--resume 与 /resume 共用
// 选中后就地换数组，不能再走 pushMessage，否则会在旧文件末尾复制一份历史
export async function pickAndResume(messages: Message[], say: Say, tui?: Tui): Promise<boolean> {
  const items = listSessions(10);
  if (!items.length) {
    say(dim("no sessions in this directory"));
    return false;
  }
  const choices = items.map((s) => ({
    value: s.file,
    label: sessionLabel(s),
    current: s.file === sessionFile(),
  }));
  let file: string | undefined;
  if (tui) {
    file = await tui.pick("Resume", choices);
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    try {
      file = await select("Resume", choices);
    } catch (e) {
      if (!(e instanceof FormAbort)) throw e;
    }
  } else {
    // 管道里没法交互选，只打印列表，保持现状当新开
    for (const s of items) say(dim(sessionLabel(s)));
    return false;
  }
  if (!file) return false; // 取消：不退出、不换档
  if (file === sessionFile()) {
    say(dim("already on this session"));
    return false;
  }
  if (!isSessionPath(file)) {
    say(red("error: session path is outside this project"));
    return false;
  }
  let loaded: Message[];
  try {
    loaded = loadMessages(file);
    bindSession(openSession(file));
  } catch (e) {
    say(red(`error: ${e instanceof Error ? e.message : String(e)}`));
    return false;
  }
  messages.length = 0;
  for (const m of loaded) messages.push(m); // 灌内存，不落盘
  lastTurn = { input: 0, output: 0 };
  clearCarry();
  distrustUsage(messages); // 上个进程留下的 usage 不拿来判断要不要压
  tui?.clear();
  replayMessages(messages, tui);
  tui?.addHistory(typedByUser(messages));
  say(dim(`resumed ${loaded.length} messages`));
  return true;
}

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
  skills: SkillSet,
  tui?: Tui,
  signal?: AbortSignal,
): Promise<"exit" | "cont"> {
  if (line === "/exit" || line === "/quit") return "exit";
  if (line === "/skills") {
    printSkills(skills, say);
    return "cont";
  }
  if (line === "/help") {
    for (const c of COMMANDS) say(dim(`${c.name.padEnd(12)} ${c.hint}`));
    if (tui) {
      say("");
      say(dim("keys"));
      for (const [k, hint] of KEYS) say(dim(`  ${k.padEnd(16)} ${hint}`));
    }
    return "cont";
  }
  if (line === "/cost") {
    const t = tokenTotals(messages);
    const turn = lastTurn.input || lastTurn.output ? ` · last turn ${fmt(lastTurn.input)} in / ${fmt(lastTurn.output)} out` : "";
    say(dim(`session  ${fmt(t.input)} in · ${fmt(t.output)} out · ${t.turns} calls${turn}`));
    return "cont";
  }
  if (line === "/clear") {
    messages.length = 0; // 就地清空，调用方拿的还是同一份数组
    lastTurn = { input: 0, output: 0 };
    clearCarry();
    resetTrust();
    endSession(); // 断档，旧 jsonl 留在磁盘，下一句用户输入开新文件
    tui?.clear();
    say(dim("(context cleared)"));
    return "cont";
  }
  if (line === "/resume") {
    await pickAndResume(messages, say, tui);
    return "cont";
  }
  if (line === "/compact") {
    const r = await runCompact(messages, signal);
    if (!r.ok) {
      // 没东西可压不是错误
      if (r.empty) say(dim(r.error));
      else if (!r.aborted) say(red(`error: ${r.error}`));
    } else {
      addCarry(r.carried);
      say(dim(compactLine(r.before, r.after, false)));
    }
    const lost = takePersistError();
    if (lost) say(dim(`session not saved: ${lost}`));
    return "cont";
  }
  if (line === "/rename" || line.startsWith("/rename ")) {
    const arg = line.slice(7).trim(); // "/rename".length === 7
    if (!arg) {
      const cur = sessionName();
      say(dim(cur ? `session  ${cur}` : "no session yet"));
      return "cont";
    }
    if (!sessionFile()) {
      say(dim("no session yet"));
      return "cont";
    }
    const next = renameSession(arg);
    const lost = takePersistError();
    if (!next || lost) say(dim(`session not saved: ${lost ?? "rename failed"}`));
    else say(dim(`renamed → ${arg}`));
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
    // 内置命令都没接住，才看是不是 skill
    const hit = skillOf(line, skills);
    if (!hit) {
      say(dim(`unknown command ${line.split(/\s/)[0]}  ·  type / for the list`));
      return "cont";
    }
    let body: string;
    try {
      body = readSkillBody(hit.skill);
    } catch (e) {
      say(red(`error: /${hit.skill.name}: ${e instanceof Error ? e.message : String(e)}`));
      return "cont";
    }
    await chat({ role: "skill", name: hit.skill.name, path: hit.skill.path, body, args: hit.args }, messages, ctx, say, signal);
    return "cont";
  }
  if (!line) return "cont";
  await chat({ role: "user", content: line }, messages, ctx, say, signal);
  return "cont";
}

// 一轮对话：发请求前自动压 → 写入这句 → agentTurn → 超限兜底 → 失败撤回
// 普通输入和 /名字 调用共用
async function chat(msg: Message, messages: Message[], ctx: AgentContext, say: Say, signal?: AbortSignal): Promise<void> {
  // 先压再写入这句。先 push 的话这句会落在分隔之前，恢复时读不到
  if (shouldAutoCompact(messages, getProvider().contextWindow)) {
    const r = await runCompact(messages, signal);
    if (!r.ok) {
      if (r.aborted) return;
      say(dim(`compact skipped: ${r.error}`));
    } else {
      addCarry(r.carried);
      say(dim(compactLine(r.before, r.after, true)));
    }
  }
  pushMessage(messages, msg);
  const before = tokenTotals(messages);
  // 比对象，不比内容。压缩保留段里还是同一个对象
  const tailIsTurn = () => messages[messages.length - 1] === msg;
  try {
    await agentTurn(messages, { ...ctx, signal });
    const after = tokenTotals(messages);
    const din = after.input - before.input;
    const dout = after.output - before.output;
    if (din || dout) lastTurn = { input: din, output: dout };
    say("");
  } catch (e) {
    if (isContextOverflowError(e)) {
      say(dim("context overflow · compacting and retrying"));
      const r = await runCompact(messages, signal);
      if (!r.ok && r.aborted) {
        // 用户打断：这句留下，不再发
      } else if (!r.ok) {
        if (tailIsTurn()) popMessage(messages);
        say(red(`error: ${r.error}`));
      } else {
        addCarry(r.carried);
        say(dim(compactLine(r.before, r.after, false)));
        try {
          await agentTurn(messages, { ...ctx, signal });
          const after = tokenTotals(messages);
          const din = after.input - before.input;
          const dout = after.output - before.output;
          if (din || dout) lastTurn = { input: din, output: dout };
          say("");
        } catch (e2) {
          if (tailIsTurn()) popMessage(messages);
          say(red(`error: ${e2 instanceof Error ? e2.message : String(e2)}`));
        }
      }
    } else {
      // 末尾仍是这句 user 才撤。压缩之后用长度判断会指错
      if (tailIsTurn()) popMessage(messages);
      say(red(`error: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  const lost = takePersistError();
  if (lost) say(dim(`session not saved: ${lost}`));
}

// 读一行再执行
export async function repl(messages: Message[], ctx: AgentContext, skills: SkillSet, tui?: Tui): Promise<void> {
  if (tui) {
    tui.setCommands([...COMMANDS, ...skillCommands(skills)]);
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
      // 内置命令不 busy，避免 /model 时 footer 还写着 esc interrupt。/compact 和 skill 要发请求，要能打断
      const chatting = !!line && (!line.startsWith("/") || line === "/compact" || !!skillOf(line, skills));
      abort = new AbortController();
      if (chatting) tui.setBusy(true);
      try {
        const r = await dispatch(line, messages, ctx, (s) => tui.writeln(s), skills, tui, abort.signal);
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
  // 以 \ 结尾的行不提交，和下一行拼起来。stdin 关掉时缓冲里剩下的也要发出去
  let pending = "";
  const take = async (text: string): Promise<boolean> => {
    const r = await dispatch(text, messages, ctx, (s) => console.log(s), skills);
    return r === "exit";
  };
  // 管道里 stdin 先 close 时，for-await 可能还在吐缓冲行；关掉后不再 prompt
  for await (const raw of rl) {
    // 行尾是 \ 才续。\ 后面还有空格则照发，这样能打出以 \ 结尾的一行。中间行不 trim，缩进要留着
    if (raw.endsWith("\\")) {
      pending += `${raw.slice(0, -1)}\n`;
      rl.setPrompt("... ");
      if (!closed) rl.prompt();
      continue;
    }
    const text = (pending + raw).trim();
    pending = "";
    rl.setPrompt("\n> ");
    if (await take(text)) break;
    if (!closed) rl.prompt();
  }
  if (pending.trim()) await take(pending.trim());
  rl.close();
}
