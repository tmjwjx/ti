# ti 设计文档

> 初版设计 · 日期：2026-08-18 · 2026-09-16 与当前实现对照 · 对应需求：`docs/PRD.md`
> 实现约束：模块化 `src/`、零运行时依赖、Node ≥22.18、双协议（Anthropic / OpenAI 兼容）
> 开发 `npm start` 直跑 TypeScript；发布 `scripts/build.mjs` 打成 `bin/ti.js`
> 当前文件树以已存在的为准。标「未做」的是初版增量，不要当成已经落地。包号对照见 `docs/VERSIONS.md`

## 1. 设计原则

1. **模块化单职责**：按层拆分，每个文件一个明确职责、可独立理解、可独立测试；不设行数硬指标，职责清晰为准
2. **零运行时依赖**：只用 Node 标准库（fs/path/os/readline/child_process）。发布用 esbuild 是 devDependency
3. **协议无关内核**：循环层/工具层只面对自定义内部消息格式（`types.ts` 的消息联合）与 `ProviderConf`，新增功能不碰协议转换层
4. **失败就地回灌**：工具失败转成 `isError` 的 toolResult 回灌模型。中断走 `finishInterrupted`（未配 toolCall 只 seal；否则 push `user("[interrupted]")`）。loop 不因这些失败崩溃
5. **状态**：当前对话是内存 `messages[]`，经 `pushMessage` 追加到 `<cwd>/.ti/sessions/*.jsonl`；配置 = `~/.ti/settings.json`；TUI 输入历史仅进程内。`~/.ti/history` 仍未做
6. **开发免构建**：Node type-stripping 直接运行 `.ts`；相对 import 必须带 `.ts` 扩展名；只用可擦除语法（无 enum/namespace/参数属性）。发布另走 minify 打包
7. **注释**：每个函数上方一两句中文说明功能/关键逻辑；复杂业务在步骤旁讲清为什么和分支。一眼能看懂的代码不堆注释。标识符英文，注释中文。

## 2. 文件架构

分层思想借鉴干净架构与优秀开源 CLI（pi 的「核心运行时 × CLI 应用」分离、Codex 的会话按项目隔离、企业服务的接口/应用/领域/基础设施四层）：**接口层（cli/）→ 应用层（core/）→ 适配层（llm/ tools/ config/）**，依赖只能由外向内，内层不知道外层的存在。

```
ti/
├── package.json / README.md / LICENSE(MIT)
├── docs/                     # PRD.md · DESIGN.md · ARCHITECTURE.md · READING.md
├── scripts/
│   └── build.mjs             # 发布：esbuild minify → bin/ti.js
└── src/
    ├── main.ts               # 唯一入口：CLI 参数、向导、装配、REPL 分发
    ├── types.ts              # 领域模型（纯类型）：Message 联合 / 内容块 / ProviderConf / StopReason
    ├── cli/                  # 接口层：终端交互（不被任何模块依赖）
    │   ├── tui.ts            #   TTY 主屏：视口、底栏、斜杠列表、setup 向导
    │   ├── repl.ts           #   斜杠命令与一轮调度（/model /provider /setup /cost /clear /resume /rename /help /exit）
    │   ├── render.ts         #   ANSI 颜色、工具参数摘要、结果预览
    │   ├── keys.ts           #   按键名、CSI/SS3 拼键、isCharKey
    │   ├── form.ts           #   全屏 select/input（非 TUI 兜底）
    │   └── setup.ts          #   配置向导
    ├── core/
    │   ├── agent.ts          #   agentTurn（llm × tools）
    │   ├── session.ts        #   当前目录 jsonl、pushMessage、list / resume / rename
    │   └── prompt.ts         #   系统提示词（AGENTS.md/CLAUDE.md）
    ├── llm/
    │   ├── index.ts          #   callLLM() 协议分发
    │   ├── sse.ts            #   sseJson() 通用 SSE 帧解析
    │   ├── anthropic.ts      #   Anthropic Messages（/v1/messages）
    │   └── openai.ts         #   OpenAI 兼容（/chat/completions）
    ├── tools/
    │   ├── index.ts          #   TOOLS schema + runTool()
    │   ├── read.ts / write.ts / edit.ts / bash.ts
    │   └── truncate.ts       #   头部截断（2000 行 / 50KB）
    └── config/
        └── index.ts          #   CATALOG、settings.json、resolveProvider()
```

初版仍待加（不要当成已有文件）：

```
scripts/smoke.mjs             # 冒烟测试
src/core/skills.ts            # skills
src/config/paths.ts           # 测试隔离用 TI_HOME
```

`core/permissions.ts` 与 `cli/input.ts` 是权限确认的设计稿，产品已决定不做，不要实现。

**依赖规则**（import 单向、无环）：

```
types.ts        纯类型，人人可依赖
适配层 config/ llm/ tools/   可被 core 依赖；llm/ 与 tools/ 完全无状态
应用层 core/    可依赖适配层与 types；绝不依赖 cli/（不知道终端的存在）
接口层 cli/     依赖 core；不被任何模块依赖（替换 UI 不影响内核）
main.ts         唯一装配点：依赖所有层，完成参数解析与分发
```

务实说明：core 直接 import 适配层具体实现，不引入接口抽象/DI 容器——项目体量下 ports-and-adapters 全套是过度设计；规则的价值在于**依赖方向单一**，不在形式。

**全局可变状态**：`config/index.ts`（当前 provider）、REPL（本轮 `AbortController`、`lastTurn`）、`session.ts`（当前写入器）。其余模块全部无状态。

**路径**：当前 `SETTINGS_PATH` 写在 `config/index.ts`（`~/.ti/settings.json`）。冒烟测试需要隔离时再抽 `config/paths.ts`，用 `TI_HOME` 整体覆盖。

## 3. 功能详细设计

### session 持久化与恢复（已落地 · 0.0.3）

#### 需求（已定）

整段对话落盘（用户、模型、工具结果、token）。第一句用户输入才建文件。只要 `ti --resume` 与 `/resume`，没有 `-c`。`/clear` 留下旧文件，下一句开新文件。恢复时历史画回屏幕并提示条数。找不到或取消：提示，当新开，不退出。恢复后仍用当前 settings / CLI 的厂家；meta 只记录当时的厂家。会话按项目物理分开，A/B 互不可见。

#### 存储

```
<cwd>/.ti/sessions/<首条用户句 slug>_<4hex>.jsonl
```

`cwd` 就是 `process.cwd()`。默认名字取首条用户句第一行：做成 slug（空白和 `/ \ : * ? " < > |` 换成 `-`，连续横杠收成一个，截到约 40 字）+ `_` + 4 位 hex。空句则只用 hex。meta 可带 `name`。`/rename 新名字` 写入 `name`，并把当前文件改成新 slug（hex 后缀保留），`writer.file` 一起改。列表优先显示 `name`，否则用首句。`.ti`、`sessions` 为 `0o700`，jsonl `0o600`。`listSessions` 按 mtime 倒序。settings 仍在 `~/.ti/settings.json`。

```jsonl
{"type":"meta","version":1,"cwd":"/Users/mac/proj/foo","provider":"deepseek","model":"deepseek-v4-flash","createdAt":"2026-09-16T12:00:00.000Z","name":"帮我改个登录bug"}
{"type":"message","role":"user","content":"帮我改个 bug"}
{"type":"message","role":"assistant","content":[...],"stopReason":"stop","usage":{"input":100,"output":40}}
{"type":"message","role":"toolResult","toolCallId":"...","toolName":"read","content":"...","isError":false}
{"type":"compact","createdAt":"..."}
```

compact 行只预留：写入器有 `markCompact()`，读的时候只取最后一个 compact 之后。`/compact` 那一版再真正压缩。

#### 模块（`src/core/session.ts`）

```ts
function sessionDir(): string                     // join(process.cwd(), ".ti/sessions")
function createSession(): SessionWriter           // 写在 sessionDir()，先写 meta
function openSession(file: string): SessionWriter
function loadMessages(file: string): Message[]    // 坏行跳过；只取最后一个 compact 之后
function listSessions(limit = 10): SessionInfo[]  // 只列 sessionDir()，mtime 倒序
function pushMessage(messages, msg): void
function popMessage(messages): void
function bindSession(w): void
function endSession(): void
function sessionFile(): string | undefined
function sessionName(): string | undefined
function renameSession(name: string): string | undefined  // 改 meta.name + 文件名，返回新路径
```

`SessionWriter`：`file` / `append` / `markCompact` / `dropLast`。模块级一个写入器。不提供 `latestSessionFor`。

#### 写入

REPL 用户句、agentTurn 里的 assistant / toolResult / `[interrupted]`，全部走 `pushMessage`：内存 push，没有写入器则 `createSession`，再 `appendFileSync` 一行。API 还没写出 assistant 就失败：`popMessage` 内存 pop + 文件 `dropLast`。

#### 挑选（`--resume` 与 `/resume` 同一套）

`listSessions(10)`。一项：时间、条数、首条用户前 48 字（cwd 已由目录隔开，标签里不写路径）。TTY + TUI：`tui.pick`。无 TUI 的 TTY：`form.select`。非 TTY：只打印列表，不当成选中。取消或这个目录没有会话：`no sessions in this directory`，保持现状。

`ti --resume`：setup、定好 provider 之后、进 REPL 之前挑。选中则 `loadMessages` + `bindSession`，`resumed N messages from …`，把历史画回屏幕，再进 REPL。不切厂家。

`/resume`：当前会话已在盘上。换一份：`messages` 就地换成载入的，`lastTurn` 清掉，TUI `clear` 后再画。选到正在写的那份：提示 already on this session。取消不动。

`/clear`：清空 `messages`、`endSession()`、TUI 清屏。旧 jsonl 不动。

#### 改哪些文件

| 文件 | 改动 |
|---|---|
| `src/core/session.ts` | 新。`<cwd>/.ti/sessions`、jsonl、push/pop/list |
| `src/core/agent.ts` | `messages.push` 改 `pushMessage` |
| `src/cli/repl.ts` | 用户句 `pushMessage`；失败 `popMessage`；`/clear` 调 `endSession`；加 `/resume` `/rename` |
| `src/cli/render.ts` | `replayMessages`：把历史画回屏幕 |
| `src/main.ts` | `--resume`；help 文案 |
| `package.json` | `0.0.3` |
| README / PRD / DESIGN / ARCHITECTURE / READING | 进度已改成已落地 |

#### 本版不做

`-c` / `--continue`、启动自动续、跨目录总表、`/resume all`、恢复时切厂家、金额、真 compact、往上找 git 根、`~/.ti/sessions` 编码目录。

### 中断（已落地）

**机制**：REPL 每轮聊天建一个 `AbortController`，经 `ctx.signal` 贯穿 `agentTurn`：

- `callLLM` → `fetch(url, { signal })`。流变量 `stopReason` 是 `StopReason | undefined`，没有线上结束原因不默认 `"stop"`；收成内部消息时未给出结束原因 → `incomplete`，说完或正式 tool 结束但参数解不开 → `badArgs`
- 流没有真实 finish（`incomplete`、`badArgs`）：不跑半截工具，seal 真实原因，屏幕只 `ui.error` 一次，停这一轮
- `toolUse`，或 `stop` 且本条已有完整 toolCall：执行工具。`incomplete`、`badArgs`、`length` 不执行
- 有 toolCall 但不执行（主要是 `length`）：补错误结果再继续；连续 3 次则停轮
- 流正常结束且无字无工具：不把空 assistant 写进历史
- bash 监听 abort → `SIGTERM`（2s 后 `SIGKILL`）
- 工具循环每次迭代前检查 `signal.aborted` → 停止后续执行

**收尾** `finishInterrupted`（互斥，屏幕只打一次 `ui.info("[interrupted]")`）：

- 栈尾有未配 toolCall：只 `sealTools`（`Error: aborted by user`），不再追加 interrupted user——调用必须有结果，否则下一轮 400
- 否则（半截字或零字节）：留下已有内容（含 user），再 `push user("[interrupted]")`，避免下一轮是没人答的提问

零字节 abort 不 throw 出循环，由收尾写入说明。有半截内容的 abort 先收下 assistant，再走同一套收尾。

**触发（TUI）**：没有 Ctrl+D。退出和打断只走 Ctrl+C：有字清空 → 向导取消 → busy 打断 → 空闲退出。Esc：向导取消 → 二级列表往回退 → busy 打断（不丢队列）→ 清空。`/exit` 退出。非 TTY readline 仍是空闲 Ctrl+C 退出。AbortSignal 贯穿 `fetch` 与 bash。

### 权限确认（设计稿，不做）

产品决定：工具直接执行，没有权限确认。下面是一份可选的 ask 方案草稿，不是当前行为，也不是默认要确认。

**配置**：`settings.json` 顶层 `permissions: "auto" | "ask"`；CLI `--ask` 强制 ask。优先级：`--ask` > settings > 默认 `auto`。

**钩子**：`agentTurn` 执行工具前调用——

```ts
async function confirmToolCall(tu: ToolUse): Promise<"allow" | "deny">
// auto 模式 / read 工具 / 本会话已 "a" 放行的工具名 → 直接 allow
// ask 模式：终端显示  `→ bash  rm -rf build/  [y]允许 [a]本会话放行 [n]拒绝`
//   非 TTY（管道）→ 打印提示并 deny
```

**提问实现**：独立 `readOneLine(prompt): Promise<string>`——直接操作 `process.stdin`（`resume()` + `once("data")`），**不新建第二个 readline 实例**（避免与 for-await 的主 rl 抢流）。调用时主 rl 正处于 await agentTurn、未读 stdin，无竞争。

**分层落位**（遵守 §2 依赖规则）：判定逻辑（auto/ask 模式、会话放行集合）放 `core/permissions.ts`，纯逻辑无 IO；终端提问（`readOneLine`/`askToolCall`）放 `cli/input.ts`；`main.ts` 作为组合根把提问函数注入 agent（`setToolCallApprover(fn)`），未注入时默认全部放行——core 不依赖 cli，且 agent 可脱离终端独立测试。

**拒绝处理**：`deny` → 不执行，结果为 `is_error:true, "Permission denied by user"` 回灌（模型据此换方案）。`a` 放行的工具名存模块级 `Set<string>`，仅本会话有效。

### /compact（未做）

**触发**：REPL `/compact`；`messages.length < 10` → 提示「历史太短，无需压缩」。

**流程**：

1. 构造压缩请求：`[...messages, {role:"user", content: COMPACT_PROMPT}]`（COMPACT_PROMPT 要求输出：已完成事项 / 改动的文件及要点 / 关键决策 / 待办，≤500 字）
2. **复用现有流式 `callLLM`**，`onText` 传空操作（不新增非流式分支）；取响应 text 块拼接为摘要
3. `session.markCompact()` 写分隔标记 → `messages = [{role:"user", content: "[此前对话摘要]\n" + summary + "\n请基于摘要继续。"}]` → 作为新消息追加进 session
4. 打印压缩前后消息条数

恢复时 `loadMessages` 只取最后一个 compact 标记之后的消息（见 session 一节），压缩效果跨进程保留。

### 输入体验（未做）

**历史持久化**：启动读 `~/.ti/history`（不存在则空），按 readline 约定**最新在前**反转后传 `createInterface({ history, historySize: 1000 })`；每接受一条非空非 `/` 命令的输入，`appendFileSync` 追加一行；文件超 1000 行时启动读取阶段截断（取最后 1000 行）。连续重复行不重复写入。

**多行输入**：REPL 循环里，若行以 `\` 结尾 → 去掉 `\`，继续读下一行拼接（提示符变为 `... `），直到不以 `\` 结尾再提交。与 for-await 天然兼容。

### token 累计与 /cost（已落地）

从 `messages` 里 assistant 的 `usage` 求和（`tokenTotals`），不另维护一份累计器。`lastTurn` 是最近一次 `agentTurn` 的差值。`/cost` 打印：`session  12,345 in · 6,789 out · 8 calls · last turn …`。footer 用 `turn ↑↓` / `session ↑↓`。不含金额（v1.1 再做价格表）。

### skills（未做）

**扫描**：`buildSystemPrompt()` 内同步扫描 `~/.ti/skills/*/SKILL.md` 与 `<cwd>/.ti/skills/*/SKILL.md`（`readdirSync` + `existsSync`，失败静默跳过）。

**frontmatter 解析**：文件以 `---` 开头 → 读到下一个 `---`；只提取单行 `name:` 与 `description:`（手写两行解析，**不引 yaml 库**）；`name` 缺省取目录名。上限 20 个，description 截断 200 字符。

**注入**（pi 同款渐进披露，模型用现有 read 工具按需读全文）：

```
Available skills (when a task matches a skill, read its SKILL.md with the read tool first):
- commit-helper: 生成规范 commit message (~/.ti/skills/commit-helper/SKILL.md)
```

### /provider 命令（已落地）

- `/provider`（无参）→ TUI 展开二级列表；非 TTY 列已就绪厂家，当前项前缀 `*`
- `/provider <name>` → `resolveProvider(name)`；失败打印错误、保持当前不变
- `/model` 只切当前厂家已写入的模型 id；未知 id 提示走 `/setup`，不随口写进 settings

## 4. 打包与发布（部分落地）

现状已按此落地。hashbang 写在构建产物上，不写在 `src/main.ts`。

```jsonc
{
  "name": "@tmjwjx/ti",
  "version": "0.0.3",
  "description": "A coding agent for the terminal",
  "type": "module",
  "bin": { "ti": "bin/ti.js" },
  "files": ["bin"],
  "engines": { "node": ">=22.18.0" },
  "scripts": {
    "start": "node src/main.ts",
    "build": "node scripts/build.mjs",
    "prepublishOnly": "npm run build"
  },
  "license": "MIT"
}
```

`scripts/build.mjs`：esbuild bundle + minify → `bin/ti.js`，`banner` 加 `#!/usr/bin/env node`，无 sourcemap。`LICENSE` 已在仓库。仍缺：`npm test` / 英文优先 README。验收仍是 `npm pack --dry-run` 仅含白名单且 <100KB；**不执行 publish**。

## 5. 冒烟测试（未做）

`scripts/smoke.mjs`（未做）：零依赖，内置两个 mock server（OpenAI 协议 + Anthropic 协议，罐头 SSE），用 `child_process` 起 `src/main.ts` 子进程并断言 stdout/退出码。场景矩阵：

| # | 场景 | 环境 | 断言 |
|---|---|---|---|
| S1 | OpenAI 协议全链路 | settings.json 的 baseURL 指 mock + 假 key | 输出含 mock 工具结果；mock 侧角色序列 `system→user→assistant+tool_calls→tool` |
| S2 | Anthropic 协议全链路 | settings.json 的 baseURL 指 mock | 同上（content_block 事件流） |
| S3 | 配置优先级 | HOME 隔离 + settings.json vs CLI | 实际请求的 baseURL/key 符合 CLI > 文件已写字段 > CATALOG |
| S4 | `/model`、`/provider` | 管道输入命令序列 | 输出包含切换后的 provider:model |
| S5 | session 恢复 | 跑一轮 → `--resume` 再起 | 第二轮请求 messages 含第一轮历史 |
| S6 | /compact | mock 第二轮返回摘要 | messages 被重置为摘要消息 |

任一断言失败 → 非零退出并打印失败项；全过打印绿字汇总。

## 6. 风险与取舍

| 风险/取舍 | 决策 |
|---|---|
| 模块化拆分引入 import 管理成本 | 约定依赖方向（§2 规则）+ 纯类型、无状态模块为主 |
| Ctrl+C 语义改变（REPL 内从「退出」变「中断 turn」） | 空闲时仍退出；忙时 footer 写 `esc interrupt` |
| 权限提问与 for-await 主循环的 stdin 竞争 | 已决定不做权限确认；设计稿留在上面，不要实现 |
| session 文件无锁、无压缩 | 单用户单进程工具，线性追加足够；pi 同样从简 |
| compact 用当前 provider 模型 | 不引入额外「小模型」配置，行为可预期 |
| TUI 用 Esc 打断 | 空闲退出仍是空输入 Ctrl+C 或 `/exit`；没有 Ctrl+D |

## 7. 实施顺序

按 `docs/VERSIONS.md` 的包号走，一个功能一个 `0.0.x`。`/compact` 依赖 session 已留下的 `markCompact` 和读时切口；其余待发项互不挡。

每个小版本：需求 → 实现方案点头 → 开发 → CR → 按 PRD 验收 → commit → 再决定 `npm publish`。
