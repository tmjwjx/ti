# 输入体验：↑ 历史回灌、`\` 续行 —— 开发大纲

> 对应包号 0.0.5 · 需求已定 · 本文是这一版的开发依据
> 功能背景与验收见 `docs/PRD.md`「输入体验」；分层约束见 `docs/DESIGN.md` §1–§2

## 0. 已定的取舍

| 项 | 定了什么 |
|---|---|
| 输入历史存哪 | 不单独存文件。`--resume` / `/resume` 时从会话里取 user 消息，灌进 TUI 的 ↑ 历史（pi 同款） |
| 新开会话按 ↑ | 空的，只有本进程里打过的 |
| 斜杠命令 | 本进程内照记；会话里不存命令，重启后翻不到 |
| 中断怎么存 | 照 pi：被打断的 assistant 标 `stopReason: "aborted"`，不再写 `user("[interrupted]")`。发请求时整条跳过 |
| 摘要怎么存 | 照 pi：单独的 `summary` 角色，只存正文和文件清单。前后缀在发请求时加 |
| 压缩 prompt | 全部换成 pi 的：system、首次摘要、合并旧摘要、序列化格式、前后缀 |
| 文件清单 | 照 pi：代码从被压掉的工具调用里统计读过、改过的文件，贴在摘要后面，多次压缩合并 |
| 会话格式版本 | 1 → 2 |
| 旧会话里的 `user("[interrupted]")` 和 0.0.4 的摘要 | 不按内容识别迁移，照旧当 user 消息 |
| ↑ 历史上限 | 1000 条，连续重复只留一条 |
| `\` 续行 | TUI 与管道两条路都做 |
| `/help` | 加快捷键段，只在 TUI 里打 |

参考了三家：Codex 存全局 `~/.codex/history.jsonl`（单次写入追加、文件锁、按字节截断）；pi 只在内存（100 条），恢复会话时从会话里回灌；dsh 交互在 Web 端，没有终端输入历史。ti 取 pi 的做法，理由是会话文件本来就是「用户说过什么」的唯一记录，再存一份就多一套要维护的持久化（并发追加、半截行、截断改写、权限），每一处都可能出新 bug。

中断和摘要也取 pi 的原则：会话里存「发生了什么」，不存「要对模型说的那句话」。

## 1. 整体思路

一句话需求：恢复会话后按 ↑ 能翻出之前发过的话；任何终端都能打多行。

拆成五块，前两块是 ↑ 回灌的前提：

```
①中断改成 aborted                      ②摘要改成 summary 角色
  不再伪装成 user                         不再伪装成 user；prompt 换成 pi 的
        │                                        │
        └──────── 做完后 user 角色里只剩用户亲手打的 ────────┐
                                                             ▼
                                               ③↑ 回灌：取 role === "user"，不用过滤

④ `\` 续行（tui.ts 的 Enter、repl.ts 的 readline 循环）
⑤ /help 快捷键段（repl.ts）
```

- **①②**是这一版动数据模型的地方，都落在「发请求前的翻译」这一个口子上：`callLLM` 进来先把内部消息翻成协议认得的三种，再交给 `anthropic.ts` / `openai.ts`。
- **③**只读不写。
- **④⑤**是纯交互层改动，和前面无关，可以单独做。

## 2. 需求覆盖

| 需求 | 由哪块实现 | 判定标准 |
|---|---|---|
| 恢复后 ↑ 翻出之前的输入 | §3.4 | `--resume` 选一份会话，按 ↑ 依次出现该会话里发过的话，最新的先出 |
| 中断与摘要不进 ↑ | §3.1–§3.2 | 压缩过、中断过的会话恢复后，↑ 里只有自己打过的话 |
| 中断后接着聊不报错 | §3.1 | 模型输出到一半、工具调用参数到一半、一个字都没回时分别打断，再发一句，三种都正常回复 |
| 摘要格式照 pi | §3.2 | 压缩后 `cat` 会话，`summary` 那行的正文是 Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context 六段 |
| 再次压缩是合并 | §3.2 | 连压两次，第二次请求里旧摘要在 `<previous-summary>` 里，结果仍是一份六段摘要 |
| 文件清单 | §3.2 | 压掉的那段里 `read` 过 A、`edit` 过 B，摘要后面有 `<read-files>A</read-files>` 和 `<modified-files>B</modified-files>` |
| 重放和运行时一致 | §3.1–§3.2 | 恢复后屏幕上，被打断处是半截内容加一行灰色 `[interrupted]`；摘要是一行灰色提示，不再画成 `❯` 全文 |
| 旧版不会悄悄读坏新文件 | §3.3 | 用 0.0.4 打开 0.0.5 写过的会话，报 `session format v2 is newer than this ti` |
| `\` 续行 | §3.5 | 输入 `a\` 回车，不发送，光标到下一行；再输 `b` 回车，模型收到 `a\nb` |
| 快捷键可见 | §3.6 | TUI 里 `/help` 在命令列表下面列出快捷键，含 Shift+Enter |

## 3. 实现逻辑

### 3.0 类型与翻译口

**类型**（`src/types.ts`）：

```ts
export type StopReason = "stop" | "length" | "toolUse" | "incomplete" | "badArgs" | "aborted";
export type SummaryMessage = {
  role: "summary";
  text: string;                                   // 模型写的摘要正文，不含前后缀
  files: { read: string[]; modified: string[] };  // 代码统计的文件清单，见 §3.2
};
export type LlmMessage = UserMessage | AssistantMessage | ToolResultMessage;  // 协议认得的三种
export type Message = LlmMessage | SummaryMessage;                           // 内部状态
```

**翻译只在一处**（`src/llm/index.ts` 的 `toLlm()`）：`callLLM` 入参仍是 `Message[]`，进来先转，再交给协议文件。`anthropic.ts`、`openai.ts` 的入参改成 `LlmMessage[]`，函数体不动。转换规则三条：

1. `summary` → user 消息，内容见 §3.2。
2. `stopReason === "aborted"` 的 assistant → 整条丢掉。
3. 相邻两条 user 合成一条（字符串用空行连接，块数组直接拼接）。第 1、2 条之后很容易出现连续 user；Anthropic 那边本来会合并，OpenAI 兼容端点有的会拒连续 user，这里统一处理。

为什么放在 `callLLM` 里面，而不是让调用方先转：调用方有两个（`agent.ts`、`compact.ts`），以后还会有。放在里面，谁都不可能把没转过的消息发出去。两个协议文件现在都是 `if user … else if assistant … else 当 toolResult`，`summary` 漏进去会被当成工具结果发出去，接口直接 400。

### 3.1 中断：照 pi 标成 aborted

pi 的做法：被打断的 assistant 照常存，`stopReason: "aborted"`，内容是打断前收到的那些（可以为空）。不写任何额外消息。发请求时整条跳过，模型从上一个完好的状态接着来。回复被跳过，里面的工具调用也跟着没了，所以不用补结果。

**`agent.ts` 的 `finishInterrupted` 改成两种情况**：

| 打断时的状态 | 存什么 | 说明 |
|---|---|---|
| 请求还在进行（流没收完，或一个字节都没收到），或者两次请求之间 | 一条 `stopReason: "aborted"` 的 assistant。流里已经收到的文字和工具调用原样放进去；没收到就是空的 `content: []`，usage 0/0 | 不补工具结果，这条会被整条跳过 |
| 工具执行阶段（assistant 已经完整收到，工具跑了一部分） | 还没出结果的工具各补一条 `Error: aborted by user`，和现在一样 | 这条 assistant 是完好的，要发给模型，所以调用必须有结果 |

- 请求返回后发现 `signal.aborted`：把收到的那条 assistant 的 `stopReason` 改成 `aborted` 再 push。这时不管它原来是 `incomplete` 还是恰好收完了，都按被打断处理。
- 屏幕上照旧只打一行 `ui.info("[interrupted]")`。流里半截的工具调用不再打 `Error: aborted by user`，因为已经不给它补结果了。

**代价**：模型看不到自己被打断前说到一半的话，也不会被告知被打断过，它看到的是「上一个问题 + 新输入」合成的一条 user。这是和 pi 一致的取舍。

### 3.2 摘要：照 pi 改成 summary 角色，prompt 换成 pi 的

**存**：`compact.ts` 的 `wrapSummary` 返回 `{ role: "summary", text, files }`。`commitCompact` 的参数类型跟着改成 `SummaryMessage`。

**发给模型时**（`toLlm` 里，前后缀照抄 pi 的 `COMPACTION_SUMMARY_PREFIX` / `SUFFIX`）：

```text
The conversation history before this point was compacted into the following summary:

<summary>
{text}

<read-files>
{files.read，一行一个}
</read-files>

<modified-files>
{files.modified，一行一个}
</modified-files>
</summary>
```

哪组清单为空就省掉那组标签，两组都空就只有正文。原来的中文前导语和 `<compacted-summary>` 标签删掉。

**压缩请求的 system prompt**（照抄 pi 的 `SUMMARIZATION_SYSTEM_PROMPT`）：

```text
You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.
```

**请求正文**：

```text
<conversation>
{序列化后的待压消息}
</conversation>

<previous-summary>          ← 只有已经压过一次时才有
{上一份摘要的 text}
</previous-summary>

{首次用 SUMMARIZATION_PROMPT，有旧摘要时用 UPDATE_SUMMARIZATION_PROMPT}
```

两段指令照抄 pi（`compaction.ts` 里的同名常量）。首次的格式：

```text
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context
```

每段下面有 pi 给的占位写法，结尾是 `Keep each section concise. Preserve exact file paths, function names, and error messages.`。合并那段额外要求：保留旧摘要的全部信息、加入新进展、把 In Progress 里做完的挪到 Done、更新 Next Steps、不再相关的可以删。

**旧摘要怎么拿**：切点之前那段里，如果 `messages[0]` 是 `summary`，它不进序列化，而是把它的 `text` 放进 `<previous-summary>`，`files` 留给清单合并。切点之前只剩这条旧摘要、没有别的消息时，算作没东西可压（`empty`），不发请求。

**序列化格式**（照抄 pi 的 `serializeConversation`）：

```text
[User]: …
[Assistant]: …
[Assistant tool calls]: read(path="src/a.ts"); bash(command="npm test")
[Tool result]: …前 2000 字符…

[... 5321 more characters truncated]
```

- 工具参数写成 `名字(键=JSON值, …)`，多个调用用 `; ` 隔开。
- 工具结果超过 2000 字符时，截断标记写明截掉了多少字符（现在 ti 只写一个 `…`）。
- 被打断的 assistant 照样序列化，它说过的话对摘要有用。pi 也是这样（它的跳过发生在发请求那一层，不在压缩这一层）。

**文件清单**（照 pi 的 `extractFileOpsFromMessage` / `computeFileLists`）：

- 扫被压掉那段里的 assistant 工具调用：`read` 的 `path` 进「读过」，`write`、`edit` 的 `path` 进「改过」。
- 再并上旧摘要的 `files`，这样多次压缩后清单覆盖整个会话。
- 同一个文件既读过又改过，只算「改过」。两组各自排序去重。
- 和 pi 有一处不同：只算真正执行成功的调用（后面有对应的 toolResult 且 `isError` 为 false）。被打断没跑的、`edit` 没找到原文失败的，都不算，免得清单里出现其实没改过的文件。

**重放**：`render.ts` 的 `replayMessages` 把 `summary` 画成一行灰色 `[compacted summary]`。

### 3.3 每一处按角色或 stopReason 分支的代码

全部列出来，漏一处就是崩或者丢数据。ti 的脚本里没有 `tsc`，开发时逐行对着这张表过，CR 再对一遍。

| 位置 | 现在的写法 | 不改会怎样 | 改法 |
|---|---|---|---|
| `llm/index.ts` `callLLM` | 直接交给协议文件 | — | 先过 `toLlm()`（§3.0） |
| `llm/anthropic.ts` / `openai.ts` `toWire` | else 当 assistant / toolResult | 不会再收到 `summary` | 只改入参类型 |
| `core/agent.ts` `finishInterrupted` | 未配调用就 seal，否则写 `user("[interrupted]")` | — | 按 §3.1 两种情况 |
| `core/agent.ts` `unmatchedToolCalls` | 从尾往前找最近一条 assistant 的未配调用 | aborted 那条的半截调用会被当成要补结果 | 碰到 aborted 的 assistant 返回空 |
| `core/session.ts` `STOPS` | 五种 | 读回时 `aborted` 被改成 `stop`，半截内容当成正常回复发出去 | 加 `aborted` |
| `core/session.ts` `asMessage` | 只认三种角色 | `summary` 整行丢掉 | 认 `summary`：`text` 须为非空字符串；`files` 缺了或形状不对就当两组空数组 |
| `core/session.ts` `repairMessages` | 非 user、非 assistant 当 toolResult；assistant 的调用都等结果 | `summary` **悄悄丢掉**；aborted 的半截调用被补上 `REPAIR` 结果 | `summary` 和 user 一样当分界；aborted 的 assistant 放进去但不登记待配调用 |
| `core/compact.ts` `estimateTokens` | 非 user、非 toolResult 当 assistant 遍历 `content` | `summary` **崩**（`content` 是 undefined） | `summary` 估 `text` 加清单路径 |
| `core/compact.ts` `serialize` | else 当 assistant | `summary` **崩** | 换成 pi 的格式；`summary` 不进序列化（§3.2） |
| `core/compact.ts` `runCompact` | 旧摘要随其他消息一起序列化 | — | 拆出旧摘要、选指令、合并清单（§3.2） |
| `cli/render.ts` `replayMessages` | else 当 toolResult；assistant 的工具调用都画 | `summary` **崩**（`content.split`） | `summary` 画一行提示；aborted 的只画文字，再画一行 `[interrupted]`，不画它的工具调用 |
| `core/compact.ts` `planCut` / `contextTokens` / `carriedUsage` | 只看 toolResult / assistant | aborted 的 usage 多为 0/0，已被跳过 | 不改 |
| `cli/repl.ts` `tokenTotals` / `tailIsTurn` | 只看 assistant / user | 不受影响 | 不改 |
| `core/session.ts` 取会话名（`pushMessage`、`openSession`、`listSessions`、`peekName`） | 取第一条 `role === "user"` | 摘要不再被当成首句 | 不改，顺带修好了 |

最后一行是顺带修掉的小问题：现在压缩过、又没有 `meta.name` 的会话，列表里显示的名字是摘要的前导语。

### 3.4 会话格式 v2

`META_VERSION` 从 1 改成 2。`assertReadable` 不用改：它本来就拒绝打开版本号比自己高的文件，所以 0.0.4 读到 v2 会报错，而不是把 `summary` 行丢掉、把 `aborted` 当成 `stop`。

新文件长这样：

```jsonl
{"type":"meta","version":2,...}
{"type":"message","role":"user","content":"帮我改 read.ts"}
{"type":"message","role":"assistant","content":[{"type":"text","text":"先看一下"}],"stopReason":"aborted","usage":{"input":0,"output":0}}
{"type":"message","role":"user","content":"换个思路"}
{"type":"compact","createdAt":"..."}
{"type":"message","role":"summary","text":"## Goal\n...","files":{"read":["src/core/session.ts"],"modified":["src/core/compact.ts"]}}
```

**旧文件接着写**：v1 文件被 `/resume` 接上之后，也可能写进 `summary` 和 `aborted`。所以 `bindSession` 占到锁之后，如果文件的 meta 版本小于 2，先把 meta 那一行原子改写成 2，再返回。`rewriteMetaName` 改成通用的 `rewriteMeta(file, patch)`，改名和升版本共用。

- 改写失败：放掉新锁，旧会话仍握在手里，异常抛给 `pickAndResume`，它已经会红字报错、不换档。
- 文件超过 32MB：跳过升级。这种文件本来就拒绝追加，写不进新内容。
- 找不到 meta 行：跳过升级，和现在读版本号的逻辑一致（当成没有版本）。

每份 v1 文件只改写一次。

npm 上的 0.0.3 没有版本检查，读到 v2 文件会出错。这一点挡不住，写进发版说明：不要用 0.0.3 打开 0.0.5 写过的会话。

**旧内容不迁移**：v1 里的 `user("[interrupted]")` 和 0.0.4 的摘要 user 消息，读回来还是 user，发给模型的内容和 0.0.4 一样。影响是恢复旧会话后 ↑ 能翻到它们、重放时摘要仍画成全文。新会话不会再有。按内容识别迁移就又回到靠字符串判断，不做。

### 3.5 ↑ 历史回灌

**TUI**（`src/cli/tui.ts`）：

- 加一个内部函数 `remember(line)`：`trim()` 后为空就跳过；和最后一条相同就跳过；否则 push，超过 1000 条删最旧的。
- `submit` 里原来的 `if (line.trim()) history.push(line)` 改成调 `remember(line)`。存的是 trim 后的，和 `repl.ts` 写进会话的形状一致，回灌时「连续重复」才判得准。
- `Tui` 类型加 `addHistory(lines: string[]): void`：逐条调 `remember`，并把 `histIdx` 复位成 -1、清掉 `draft`，防止正翻着历史时下标错位。

去重和上限只写在 `remember` 里，打字提交和回灌两条路规则永远一致。

**回灌**（`src/cli/repl.ts` 的 `pickAndResume`）：载入成功、`replayMessages` 之后，调 `tui?.addHistory(...)`，传入 `messages` 里所有 `role === "user"` 的文本（`content` 是块数组时拼成文本）。`--resume` 和 `/resume` 都走这里，只有这一个调用点。没有 TUI（管道）时 `tui` 为空，自然跳过。

**`/resume` 切到另一份**：本进程已有的 ↑ 历史保留，新会话的输入接在后面，按 ↑ 先出来的是新会话的最后一句。pi 也是这个顺序。

**`/clear`**：不动 ↑ 历史。它是输入历史，不是会话。

**压缩过的会话**：只能翻到保留段里的输入，被摘要替换掉的那部分翻不到。这是回灌方案的已知代价。

### 3.6 `\` 续行

**TUI**：在 Enter 的处理里，向导（`wizard`）判断之后、斜杠命令列表判断之前，加一条：光标前一个码点是 `\` 时，删掉它并插入 `\n`，不提交。

- 放在命令列表判断之前，是因为 `/xxx\` 回车时用户的意思是换行，不是选中列表项。
- 只看光标前一个字符，光标在中间也能用，和 Shift+Enter 的效果一样。
- 想发一条以 `\` 结尾的消息：反斜杠后面加个空格再回车。
- 续行拼出来的是带 `\n` 的一整条，进 ↑ 历史也是一整条，翻出来还是多行。

**管道**（`repl.ts` 的 readline 循环）：加一个缓冲。读到以 `\` 结尾的行，去掉 `\`、接上 `\n` 攒着，提示符换成 `... `，不 dispatch；读到不以 `\` 结尾的行，把缓冲和这行拼起来一起 dispatch，提示符换回 `\n> `。stdin 关闭时缓冲里还有东西，也 dispatch 掉，不丢。

### 3.7 `/help` 快捷键段

`repl.ts` 里在 `COMMANDS` 旁边加一个常量 `KEYS`，`/help` 打完命令列表后，有 TUI 时再打一段：

```text
keys
  enter            send
  shift+enter      newline (or \ then enter)
  ↑ / ↓            history
  esc              interrupt / back
  ctrl+c           clear · interrupt · quit
  pageup/pagedown  scroll
```

只列常用的。完整编辑键（Ctrl+A/E/U/K 等）在 `docs/PRD.md` §4.4。管道模式没有按键，不打。

## 4. 落点

| 文件 | 改什么 |
|---|---|
| `src/types.ts` | `StopReason` 加 `aborted`；加 `SummaryMessage`、`LlmMessage`；`Message` 扩成四种 |
| `src/llm/index.ts` | `toLlm()`（摘要翻译、跳过 aborted、合并相邻 user）；`callLLM` 进来先转；摘要前后缀常量 |
| `src/llm/anthropic.ts` / `openai.ts` | 入参类型改成 `LlmMessage[]` |
| `src/core/agent.ts` | `finishInterrupted` 按 §3.1 两种情况；`unmatchedToolCalls` 跳过 aborted |
| `src/core/compact.ts` | 换成 pi 的 system prompt、两段指令、序列化格式；拆出旧摘要放 `<previous-summary>`；文件清单统计与合并；`wrapSummary` 返回 `summary` 角色；`estimateTokens` 处理 `summary`；删掉中文前导语和 `<compacted-summary>` |
| `src/core/session.ts` | `META_VERSION = 2`；`STOPS` 加 `aborted`；`asMessage` 认 `summary`；`repairMessages` 按 §3.3；`rewriteMeta` 通用化；`bindSession` 升级 v1；`commitCompact` 参数类型 |
| `src/cli/render.ts` | `replayMessages` 画 `summary` 与 aborted |
| `src/cli/tui.ts` | `remember()`；`submit` 改调它；`addHistory()`；Enter 的 `\` 续行 |
| `src/cli/repl.ts` | `pickAndResume` 回灌；readline 循环的 `\` 续行；`KEYS` 与 `/help` |
| `package.json` / `package-lock.json` | `0.0.5`（CR 之后） |
| 文档 | 开发完更新 `ARCHITECTURE.md`、`READING.md`、`VERSIONS.md` 状态；`docs/impl/compact.md` 里 prompt 与落盘相关段落标注已被本文替换 |

`main.ts` 不改：`--resume` 本来就经 `pickAndResume`，TUI 在那之前已经建好。

## 4.1 已知风险

- **漏改一处分支**：§3.3 表里标了「崩」「悄悄丢掉」的几处必须改。没有 `tsc`，靠编辑器和 CR。
- **模型看不到被打断的半截回复**：照 pi 的取舍。用户接着说「不对，别那样改」时，模型不知道「那样」指什么。
- **摘要变成英文**：pi 的 prompt 是英文的，中文对话压出来的摘要多半是英文，或者中英混杂。对模型接续没有影响，只是 `cat` 会话时读起来不一样。
- **npm 0.0.3 打开 v2 文件**：没有版本检查，会出错。写进发版说明。
- **v1 文件升级是整文件改写**：每份一次，≤32MB，走原子写。改写中途崩掉，原件不受影响（先写临时文件再 rename）。
- **压缩过的会话 ↑ 只剩保留段的输入**：回灌方案的固有代价。

## 5. 不做

全局输入历史文件（`~/.ti/history.jsonl`）、Ctrl+R 反向搜索、按内容迁移旧会话、`/history` 命令、括号粘贴、pi 的 split turn（一轮太大时拆成前后两段分别摘要）、摘要请求的输出上限（pi 是预留量的 80%）。

以后真要跨会话历史：TUI 只认 `addHistory(lines)`，启动时多一个数据来源往里灌即可，§3.5 不用推翻。

## 6. 待确认

无。
