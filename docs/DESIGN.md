# ti 设计文档

> 初版设计 · 日期：2026-08-18 · 2026-09-16 与当前实现对照 · 对应需求：`docs/PRD.md`
> 实现约束：模块化 `src/`、零运行时依赖、Node ≥22.18、双协议（Anthropic / OpenAI 兼容）
> 开发 `npm start` 直跑 TypeScript；发布 `scripts/build.mjs` 打成 `bin/ti.js`
> 当前文件树以已存在的为准。标「未做」的是初版增量，不要当成已经落地。包号对照见 `docs/VERSIONS.md`
> 测试：`npm test`（`node:test`，见 §5）

## 1. 设计原则

1. **模块化单职责**：按层拆分，每个文件一个明确职责、可独立理解、可独立测试；不设行数硬指标，职责清晰为准
2. **零运行时依赖**：只用 Node 标准库（fs/path/os/readline/child_process）。发布用 esbuild 是 devDependency
3. **协议无关内核**：循环层/工具层只面对自定义内部消息格式（`types.ts` 的消息联合）与 `ProviderConf`，新增功能不碰协议转换层
4. **失败就地回灌**：工具失败转成 `isError` 的 toolResult 回灌模型。中断走 `finishInterrupted`（工具阶段被打断：给没跑的工具补错误结果；请求中被打断：存一条 `stopReason: "aborted"` 的 assistant，发请求时整条跳过）。loop 不因这些失败崩溃
5. **状态**：当前对话是内存 `messages[]`，经 `pushMessage` 追加到 `<cwd>/.ti/sessions/*.jsonl`；配置 = `~/.ti/settings.json`；TUI 输入历史在进程内，恢复会话时从会话里回灌，不单独存文件
8. **存事实，不存话术**（取自 pi）：摘要是单独的 `summary` 角色，中断是 assistant 的 `stopReason: "aborted"`，会话里只记发生了什么。要对模型说的那句话（摘要前后缀）只在 `callLLM` 的 `toLlm()` 里生成，aborted 的回复也在那里跳过
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
├── test/                     # node:test，npm test（见 §5）
│   ├── helpers.ts            #   临时 HOME 与项目目录、假 fetch、罐头 SSE、记录事件的 AgentUI
│   └── *.test.ts             #   一个主题一个文件
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
    │   ├── compact.ts        #   上下文压缩
    │   ├── skills.ts         #   .ti/skills 与 ~/.ti/skills 扫描、清单、读全文
    │   └── prompt.ts         #   系统提示词（AGENTS.md/CLAUDE.md、skill 清单）
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

**路径**：`SETTINGS_PATH` 写在 `config/index.ts`（`~/.ti/settings.json`），import 时按 `homedir()` 算出。测试先改 `HOME` 再 import 来隔离（§5）。

## 3. 功能详细设计

### session 持久化与恢复（已落地 · 0.0.3）

#### 需求（已定）

整段对话落盘（用户、模型、工具结果、token）。第一句用户输入才建文件。只要 `ti --resume` 与 `/resume`，没有 `-c`。`/clear` 留下旧文件，下一句开新文件。恢复时历史画回屏幕并提示条数。找不到或取消：提示，当新开，不退出。恢复后仍用当前 settings / CLI 的厂家；meta 只记录当时的厂家。会话按项目物理分开，A/B 互不可见。

#### 存储

```
<cwd>/.ti/sessions/<首条用户句 slug>_<4hex>.jsonl
```

`cwd` 就是 `process.cwd()`。默认名字取首条用户句第一行：做成 slug（控制字符丢掉，空白和 `/ \ : * ? " < > |` 换成 `-`，去掉头尾点，截到约 40 字）+ `_` + 4 位 hex。空句则只用 hex。meta 可带 `name`。`/rename 新名字` 写入 `name`，并把当前文件改成新 slug（hex 后缀保留），`writer.file` 一起改。列表优先显示 `name`，否则用首句。`.ti`、`sessions` 为 `0o700`，jsonl `0o600`。`listSessions` 先按 mtime 排序再解析前 10 份。settings 仍在 `~/.ti/settings.json`。

覆写走临时文件 + fsync + rename。追加后 fsync。文件若不以换行结尾，下一次追加先补一个换行，避免半截 JSON 粘住新行。撤回最后一条按字节截断，不把中文按字符下标重写。同一份 jsonl 带 `.lock`（pid），两份 ti 不能同时写。改名用硬链接，先占新锁再放开旧名，不覆盖已有文件。恢复时补齐缺失的 toolResult、丢掉对不上的结果。单文件超过 32MB 拒绝再追加，读的时候只取尾部。打开路径必须落在当前 `sessions` 目录。不碰用户项目的 `.gitignore`。落盘失败不打断对话，提示 `session not saved`。

```jsonl
{"type":"meta","version":1,"cwd":"/Users/mac/proj/foo","provider":"deepseek","model":"deepseek-v4-flash","createdAt":"2026-09-16T12:00:00.000Z","name":"帮我改个登录bug"}
{"type":"message","role":"user","content":"帮我改个 bug"}
{"type":"message","role":"assistant","content":[...],"stopReason":"stop","usage":{"input":100,"output":40}}
{"type":"message","role":"toolResult","toolCallId":"...","toolName":"read","content":"...","isError":false}
{"type":"message","role":"assistant","content":[...],"stopReason":"aborted","usage":{"input":0,"output":0}}
{"type":"compact","createdAt":"..."}
{"type":"message","role":"summary","text":"## Goal\n...","files":{"read":[...],"modified":[...]}}
```

读的时候只取最后一个 compact 之后。还没有正式版，也没有存量文件，格式直接改，不做旧格式兼容；`version` 保持 1，版本号比自己高的文件拒绝打开。

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
function isSessionPath(file: string): boolean
function takePersistError(): string | undefined
```

`SessionWriter`：`file` / `append` / `markCompact` / `dropLast`。模块级一个写入器。不提供 `latestSessionFor`。

#### 写入

REPL 用户句、agentTurn 里的 assistant（含被打断的）/ toolResult，全部走 `pushMessage`：内存 push，没有写入器则 `createSession`，再追加一行并 fsync。API 还没写出 assistant 就失败：`popMessage` 内存 pop + 文件 `dropLast`。

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
- bash 监听 abort → 给整个进程组发 `SIGTERM`（2s 后 `SIGKILL`），管道和复合命令里的子进程一起杀
- 工具循环每次迭代前检查 `signal.aborted` → 停止后续执行

**收尾** `finishInterrupted`（互斥，屏幕只打一次 `ui.info("[interrupted]")`）：

0.0.5 起照 pi 改（详见 `docs/impl/history.md` §3.1）：

- 工具执行阶段被打断（assistant 已完整收到）：没跑的工具各补一条 `Error: aborted by user`——这条 assistant 要发给模型，调用必须有结果，否则下一轮 400
- 请求中被打断（半截字、半截工具调用、零字节），或两次请求之间：存一条 `stopReason: "aborted"` 的 assistant，内容是已经收到的部分（可以为空）。不补工具结果，不写额外消息。发请求时 `toLlm()` 整条跳过，模型看到的是「上一个问题 + 新输入」合成的一条 user

零字节 abort 不 throw 出循环，由收尾写入空的 aborted assistant。

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

### /compact 上下文压缩（已落地 · 0.0.4）

> 实现文档另开一页：`docs/impl/compact.md`（切点算法、落点清单、阈值换算都在那里）。本节只留设计取舍。

参考 pi、Codex、dsh 三家的共识定的：按 token 比例触发（不按消息条数）、摘要用固定分段、保留最近若干轮（不是只留一条摘要）、重复压缩把上一次摘要合并进去。三家阈值分别是「窗口减预留 16384」「窗口 90%」「窗口 80%」；保留量分别是「固定 20000 token」「只留摘要」「窗口 16%」。ti 取 80% 触发、保留窗口 16% 且不低于 20000。

#### 模型窗口（新增配置）

`CatalogEntry.models` 的每一项加 `contextWindow`（token 数）。`settings.json` 里 `providers.<name>.models` 同样可写，优先级与其他字段一致。`ProviderConf` 跟着加 `contextWindow?: number`，由 `resolveProvider` 带出来。

取不到窗口大小的模型：自动压缩整体关闭，只有手动 `/compact` 可用。不猜默认值。

#### 触发

| 入口 | 条件 |
|---|---|
| `/compact` | 你敲命令，随时可压 |
| 自动 | 每轮用户输入发请求前，估算 token 超过窗口 80% |
| 兜底 | 请求回来报上下文超限，压一次再重试这一轮 |

估算取最后一条 assistant 的 `usage.input + usage.output`；还没有 assistant 就不估（首轮不会超）。这个值就是上一轮真实发出去的量，比自己数字符准。

#### 切在哪里

从最新往前累加 `estimateTokens`（CJK 一字一 token，其余四字一 token），到达保留量（窗口 16%，不低于 20000、不高于 40000）就停，这一点之后的保留，之前的交给模型做摘要。

切点只能落在 `user` 或 `assistant` 上，绝不落在 `toolResult`——工具结果必须紧跟它的调用。保留段头部若是孤立的 `toolResult`（对应的调用已经被切走），直接丢掉。摘要段里未配结果的调用不必补，因为整段会被摘要替换掉。

没有可压的部分（比如只剩摘要加一条巨大的工具结果）：不发请求，提示后返回。

#### 摘要

复用现有流式 `callLLM`，`onText` 传空操作，不新增非流式分支。用当前 provider 当前模型，不另配小模型。这一次的 token 照常进 `usage`，`/cost` 和底栏都算上。

请求内容是把要压缩的那段对话序列化成文本，包在标签里，后面跟压缩指令——不是把历史当对话继续发，避免模型接着聊。固定分段，缺的段写 `(none)` 而不是省掉：原始意图、关键技术点、涉及文件与改动、出过的错与怎么解决、待办、当前进度、下一步、关键约束与决定。要求原样保留文件路径、命令、报错原文、函数名。不限字数，靠生成上限约束。

#### 落盘与内存

1. 模型给出摘要文本后，`session.markCompact()` 写分隔行
2. 摘要作为一条 `summary` 角色的消息追加进 session，只存正文和文件清单（0.0.4 存的是带前导语的 `user`，0.0.5 起改）
3. 保留段重新追加一遍
4. 内存 `messages` 换成：摘要那条 + 保留段

发请求时 `toLlm()` 把 `summary` 翻译成 user 消息，前后缀照 pi：`The conversation history before this point was compacted into the following summary:` 加 `<summary>…</summary>`。

**0.0.5 起 prompt 换成 pi 的**：system prompt、六段格式（Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context）、`[User]: …` 这种序列化格式都照抄 pi；摘要后面由代码贴上读过、改过的文件清单。详见 `docs/impl/history.md` §3.2。

分隔之前的原文全部留在文件里，`cat` 还能看到。`loadMessages` 只取最后一道分隔之后，所以压缩效果跨进程保留。

#### 重复压缩

支持。第二次压缩时，历史里已有的摘要（`summary` 角色）不进序列化，单独放进 `<previous-summary>`，改用 pi 的合并指令：保留旧信息、加入新进展、把做完的从 In Progress 挪到 Done。文件清单由代码把新旧两份合并。结果仍是一份摘要，不是两份叠着。

#### 屏幕

只打一行：`compacted · 48,200 → 9,600 tokens`。自动触发时前面加触发标记。不打消息条数，不清屏，历史留在上面。

#### 失败与中断

压缩请求走本轮的 `AbortSignal`，Esc 或 Ctrl+C 能打断。打断、请求失败、模型没给出可用文字，三种都不改内存、不写文件，只报错——宁可不压，不能压出空摘要把历史弄丢。

自动压缩失败不挡你这一轮：照原样把请求发出去，宁可这一轮贵一点。

#### 兜底：模型报上下文超限

自动压缩按 80% 估算，工具结果很大或窗口值配错时照样会撞上限。现在这类错误直接抛到 REPL 红字报错，历史没变，再问一次还是撞。

`callLLM` 失败时匹配上下文超限特征（HTTP 400 且消息含 `context length` / `maximum context` / `too many tokens` 一类字样，各家措辞不同，用关键词）。认不出就当普通错误照原样报。

认出来：提示 `context overflow · compacting and retrying`，走同一套压缩，然后把这一轮重发一次。**整轮只重试一次**，压完再撞就报错——说明单条内容本身超了，再压没用（根子在工具输出截断，不在这一版）。

这一轮的 user 消息保留，不走 `popMessage`——重试要用它。压缩和重试都失败了，才按现有规则撤回。

#### 本版不做

自动压缩的开关与阈值配置项（先写死）、`/compact` 带自定义指令、切点跨轮细分（pi 的 split turn）、把工具结果单独裁剪（dsh 的 pruner）、摘要落进单独文件。

### 输入体验（已落地 · 0.0.5）

> 实现文档另开一页：`docs/impl/history.md`（每处角色分支的改法、落点清单都在那里）。本节只留设计取舍。

#### ↑ 历史：从会话回灌，不单独存文件

参考了三家：Codex 存全局 `~/.codex/history.jsonl`；pi 只在内存，恢复会话时从会话里回灌；dsh 没有终端输入历史。ti 取 pi 的做法。会话文件本来就是「用户说过什么」的唯一记录，再存一份就要再维护一套持久化（并发追加、半截行、截断改写、权限）。

`--resume` / `/resume` 载入后，把 `role === "user"` 的消息灌进 TUI 的 ↑ 历史。本进程已有的保留，新会话的接在后面。`/clear` 不动 ↑ 历史。上限 1000 条，连续重复只留一条，去重和上限只在 TUI 的 `remember()` 里写一次。

代价：新开会话 ↑ 为空；斜杠命令不进会话，重启后翻不到；压缩掉的那部分输入翻不到。

#### 前提：摘要和中断不再伪装成 user（照 pi）

回灌要求 user 角色里只有用户亲手打的。0.0.4 及之前，摘要和 `[interrupted]` 都伪装成 user 存着。0.0.5 起照 pi：

- 中断：被打断的 assistant 标 `stopReason: "aborted"`，不写额外消息，发请求时整条跳过。中断不能当工具回复写：大多数中断发生时没有工具调用，工具回复没有 id 可挂，两个协议都会 400。
- 摘要：单独的 `summary` 角色，只存正文和文件清单，前后缀在发请求时加。压缩 prompt 一并换成 pi 的。

翻译集中在 `callLLM` 里的 `toLlm()`：摘要翻成 user、跳过 aborted、合并相邻 user。

这一步顺带让恢复时的重放和运行时一致：被打断处画半截内容加一行 `[interrupted]`，摘要画一行提示，不再把摘要全文画成用户消息。

#### `\` 续行

光标前一个字符是 `\` 时按 Enter：删掉 `\`、插入换行、不提交。不支持 modifyOtherKeys 的终端里 Shift+Enter 进来就是普通回车，这是那里唯一能打多行的办法。管道模式下以 `\` 结尾的行和下一行拼起来再提交。

#### `/help` 快捷键

TUI 下 `/help` 在命令列表后面加一段常用快捷键（send、newline、history、interrupt、quit、scroll）。Shift+Enter 换行早就有，这里把它写出来。

### token 累计与 /cost（已落地）

从 `messages` 里 assistant 的 `usage` 求和（`tokenTotals`），不另维护一份累计器。`lastTurn` 是最近一次 `agentTurn` 的差值。`/cost` 打印：`session  12,345 in · 6,789 out · 8 calls · last turn …`。footer 用 `turn ↑↓` / `session ↑↓`。不含金额（v1.1 再做价格表）。

### skills（已落地 · 0.0.6）

> 实现文档另开一页：`docs/impl/skills.md`（解析规则、各处接 `skill` 角色的改法、落点清单都在那里）。本节只留设计取舍。

参考了三家：pi 在提示词里列清单、模型用 `read` 读全文，另有 `/skill:名字` 手动调；Codex 同样列清单，另加「用户点名就必须读」；dsh 用专门的 `skill` 工具。ti 取 pi 的做法，不新增工具。

**扫描**：启动时扫 `<cwd>/.ti/skills/<名字>/SKILL.md`，再扫 `~/.ti/skills/<名字>/SKILL.md`，同名项目级优先。只看当前目录，只认一层，跟随符号链接。只扫一次，新加的要重启。

**frontmatter**：手写解析，不引 yaml 库。认 `name`（缺省取目录名）、`description`（必填，缺了不加载）、`disable-model-invocation`。支持单行、带引号、`|` / `>` 多行、不带引号的换行续写、行尾 `#` 注释。名字不合规、描述超 1024 只警告（pi 的规则）。

**进系统提示词**：照 pi 的 `<available_skills>` XML 和开头说明，只列名字、描述、路径。不加 Codex 的「用户点名就先读」，避免 `/名字` 注入全文后模型再读一遍。`disable-model-invocation` 的不列。清单超过 2 万字符的部分不列，仍可手动调。

**`/名字 参数`**：照 dsh，不加前缀，skill 叫 `aaa` 就是 `/aaa`。内置命令先解析，对不上才找 skill；和内置命令同名的 skill 不能这样调，`/skills` 里有警告，模型照样能读。读出全文和参数一起在这一轮发给模型。会话里存成单独的 `skill` 角色，带调用那一刻的全文，之后改了 `SKILL.md` 也不影响已有会话；发请求时 `toLlm()` 翻成 pi 那种 `<skill name=… location=…>` 的 user 消息。屏幕和 ↑ 历史显示成用户打的原样。

**`/skills`**：列出已加载的、来自哪个目录、有没有被隐藏或挤出清单，以及警告。

**顺带修**：TUI 命令列表回车会丢参数（`/rename foo` 只提交了 `/rename`），改成带参数时提交整行。

### /provider 命令（已落地）

- `/provider`（无参）→ TUI 展开二级列表；非 TTY 列已就绪厂家，当前项前缀 `*`
- `/provider <name>` → `resolveProvider(name)`；失败打印错误、保持当前不变
- `/model` 只切当前厂家已写入的模型 id；未知 id 提示走 `/setup`，不随口写进 settings

## 4. 打包与发布（部分落地）

现状已按此落地。hashbang 写在构建产物上，不写在 `src/main.ts`。

```jsonc
{
  "name": "@tmjwjx/ti",
  "version": "0.0.4",
  "description": "A coding agent for the terminal",
  "type": "module",
  "bin": { "ti": "bin/ti.js" },
  "files": ["bin"],
  "engines": { "node": ">=22.18.0" },
  "scripts": {
    "start": "node src/main.ts",
    "build": "node scripts/build.mjs",
    "test": "node --test test/*.test.ts",
    "prepublishOnly": "npm run build"
  },
  "license": "MIT"
}
```

`scripts/build.mjs`：esbuild bundle + minify → `bin/ti.js`，`banner` 加 `#!/usr/bin/env node`，无 sourcemap。`LICENSE` 已在仓库。仍缺：英文优先 README。验收仍是 `npm pack --dry-run` 仅含白名单且 <100KB；**不执行 publish**。`test/` 不在 `files` 里，不进包。

## 5. 测试（已开发 · 0.0.7，待 CR）

#### 框架与入口

Node 自带的 `node:test` + `node:assert/strict`，不加任何依赖。`npm test` 就是 `node --test test/*.test.ts`：Node ≥22.18 直接跑 `.ts`，规矩和 `src/` 一样（相对 import 带 `.ts`，只用可擦除语法）。`tsconfig.json` 的 `include` 带上 `test/**/*.ts`，测试和源码一起过 `tsc --noEmit`。

`test/` 平铺，一个主题一个文件（`skills.test.ts`、`session.test.ts`、`agent.test.ts`……）。共用的东西放 `test/helpers.ts`，它本身不是测试文件。

#### 两类测试（照 pi）

1. **函数单测**，占大头。直接调已经导出的函数：skill 扫描与 frontmatter、`toLlm`、错误判别、压缩的估算与切点、会话落盘与修补、工具、配置优先级、按键解析、`replayMessages`。
2. **进程内流程测试**。把 `globalThis.fetch` 换成按顺序回放罐头响应的假实现（`fakeFetch`），回包是 OpenAI chat/completions 或 Anthropic Messages 的 SSE 帧，然后直接调 `callLLM`、`agentTurn`、`runCompact`、`repl`。假 fetch 记下每次请求的地址、头和 body，断言就落在「发出去的线格式」和「收回来的内部消息」两头。每个测试结束还原 fetch。

不起 ti 子进程，不起 HTTP 服务，不用真 key，不碰网络。工具是真的跑（`write`、`read`、`bash` 在临时目录里执行）。

#### 隔离

`config/index.ts` import 时就读 `~/.ti/settings.json`，`session.ts`、`skills.ts` 用的是 `process.cwd()`。所以每个测试文件开头先调 `isolate()`：建一份临时根目录，`HOME` 指到里面的 `home/`，`process.chdir` 进 `project/`，进程退出时整份删掉；之后才用顶层 `await import()` 引 `src/`。`node --test` 每个文件单独一个进程，模块级状态（当前会话 writer、当前厂家、压缩的可信标记、repl 的用量结转）不会串到别的文件；同一文件内靠 `endSession`、`resetTrust`、`reloadSettings` 在 `beforeEach` 里复位。不会碰真实的 `~/.ti`，也不会碰仓库自己的 `.ti/`。

#### 几处写法

- **罐头 SSE**：`openaiStream`、`anthropicStream` 按参数拼帧（文本碎片、按 index 分片的工具参数、结束原因、用量）；每项是一个网络包，可以故意切在半帧中间。
- **中断**：回包带 `hang` 时，包发完后流卡住并回调一次，测试在回调里 `abort()`，流随之以 AbortError 结束。这样「收到半截再被打断」「一个字节都没收到就被打断」都是确定的，不靠计时。工具阶段的打断用 `recordUI` 的 `onToolCall` 钩子，在微任务里 abort，打断的一定是已经起来的 `bash`。
- **不断言耗时**：bash 的超时、打断都跑 `sleep 60`，没被杀就不会自然结束，只断言结果里的 `killed by SIGTERM (timeout)` 或 `(interrupted)`；测试级 `timeout` 只防卡死。并行跑、机器忙时也不抖。
- **TUI**：`openTui()` 之后往 `process.stdin` 上 `emit("data", …)` 喂按键，结果从 `readLine()` 取。测试期间吞掉 `process.stdout.write` 的字符串输出；测试进程向 `node --test` 汇报用的是 Buffer，要放行，否则结果会丢。单独的 Esc 要过 40ms 拼键超时，用 `mock.timers` 拨钟，不真等。
- **REPL**：`dispatch` 不导出，走导出的 `repl(messages, ctx, skills, tui)`，传一个按脚本吐输入行、记下所有输出的假 `Tui`，斜杠命令、普通对话、skill 调用、`/compact`、自动压缩、超限重试、`/resume` 都从这一条路进去。
- **拼键超时**：`createKeyAssembler` 用 `node:test` 的 `mock.timers` 拨钟。

#### 测试查出、这一版修掉的

- `llm/sse.ts` 只按 `\n\n` 切事件，CRLF 分隔的 SSE 一帧都解析不出来。改成事件和行都同时认 `\n` 与 `\r\n`
- `tools/bash.ts` 打断或超时只给 `sh` 发 SIGTERM，复合命令（`a; sleep 10`、管道）里的子进程继续跑并占着输出，要等它自己跑完才返回。改成命令自成一个进程组（POSIX 上 `detached`），打断、超时、ti 退出时杀整个组；超时改成自己计时，不用 `spawn` 的 `timeout`（它同样只杀 `sh`）

#### 这版不测

- `main.ts` 的参数解析与装配、`cli/setup.ts` 与 `cli/form.ts` 的全屏交互、`repl()` 的非 TTY readline 分支：都要真终端或子进程，按约定不起子进程
- TUI 的具体重绘内容（行级 diff、列宽折行）：只测输入到提交的行为，不对屏幕字节做快照

## 6. 风险与取舍

| 风险/取舍 | 决策 |
|---|---|
| 模块化拆分引入 import 管理成本 | 约定依赖方向（§2 规则）+ 纯类型、无状态模块为主 |
| Ctrl+C 语义改变（REPL 内从「退出」变「中断 turn」） | 空闲时仍退出；忙时 footer 写 `esc interrupt` |
| 权限提问与 for-await 主循环的 stdin 竞争 | 已决定不做权限确认；设计稿留在上面，不要实现 |
| session 并发与掉电 | 同文件 `.lock`（pid，死进程可抢）；覆写 tmp+fsync+rename；追加 fsync。不做 SQLite / CRDT |
| compact 用当前 provider 模型 | 不引入额外「小模型」配置，行为可预期 |
| TUI 用 Esc 打断 | 空闲退出仍是空输入 Ctrl+C 或 `/exit`；没有 Ctrl+D |

## 7. 实施顺序

按 `docs/VERSIONS.md` 的包号走，一个功能一个 `0.0.x`。`/compact` 依赖 session 已留下的 `markCompact` 和读时切口；其余待发项互不挡。

每个小版本：需求 → 实现方案点头 → 开发 → CR → 按 PRD 验收 → commit → 再决定 `npm publish`。
