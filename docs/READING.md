# 相对 0.0.2 的变更阅读指南

对照点：git `8d9838c`（0.0.2）→ 当前工作区（未发版、未 commit）。
0.0.2 里已经懂的（`sse.ts`、两家协议 toWire、`prompt.ts`、read/write/truncate、agent 主循环骨架）**跳过**。这里只标差异。

本地：`npm start`。别用全局 `ti`。

---

## 没动，不用重读

`src/tools/{read,write,truncate}.ts` · `src/llm/sse.ts` · `src/core/prompt.ts`

OpenAI 的 **toWire** 没变。Anthropic 相邻 user 合成一条。流结束与 abort 见下面 llm 一节。

---

## 建议顺序（只读变更）

新文件整篇读。旧文件按「看哪」读，不要通篇。

```
1. config/index.ts     目录替换预设；saveSettings 文件 0o600、目录 0o700
2. cli/keys.ts         新 · 按键解码、拼键、isCharKey
3. cli/form.ts         新 · 全屏 select/input
4. cli/setup.ts        新 · 首次指引
5. main.ts             装配；--provider 失败就退出
6. cli/render.ts       UI 可注入 TUI
7. llm/ + tools/bash   signal；stopReason | undefined
8. tools/edit.ts       对着原文 indexOf，倒序 slice
9. core/agent.ts       finishInterrupted / 流失败停轮
10. cli/repl.ts        命令 + TUI 循环 + 失败 pop
11. cli/tui.ts         新 · 最大块
12. types.ts           StopReason：incomplete、badArgs
```

---

## 新文件（四份）

### [src/cli/keys.ts](../src/cli/keys.ts)

按键解码。`parseKey("\\x1b[A")` → `"up"`，`parseKey("\\x03")` → `"ctrl+c"`。
CSI、SS3、C0、kitty CSI u、modifyOtherKeys 都在这里。`form`、`tui` 只认名字。
`createKeyAssembler`：ESC 后 `O` 再等一字节（SS3），CSI 等到 `@`–`~`；半截 40ms 丢掉、不重放。
`isCharKey` 按码点判断该不该写入，emoji 能进。Ctrl+A 是不是行首，不在这层，在 tui 的 `EDITOR`。

### [src/cli/form.ts](../src/cli/form.ts)

全屏控件：`select`、`input`，`\x1b[H\x1b[J` 画在屏顶。`FormAbort` = Esc 或 Ctrl+C。
拼键走 `createKeyAssembler`。插入走 `isCharKey`。

**TUI 下 setup 不再走这里。** 只给非 TTY / 无 TUI 兜底。`/model` `/provider` 在 TUI 里也不走这里。

### [src/cli/setup.ts](../src/cli/setup.ts)

状态机。有 TUI 用 `tui.pick` / `tui.ask`（底栏），没有才用 form。

- 已有 ready 厂家：先 intent（给当前家加模型 / 加另一家 / 换 key）
- 已有 key 且不是换 key：选完模型直接 `save`，不再贴 key
- 三家只 `writeProvider({ apiKey, model })`，不写 protocol/baseURL（留给 `CATALOG`）
- Custom 写全
- 返回 `"saved" | "cancel"`。intent / 第一页 Esc = cancel

### [src/cli/tui.ts](../src/cli/tui.ts)

0.0.2 没有这个文件。TTY 交互全在这。按块读，不要从上到下硬啃：

| 块 | 看什么 |
|---|---|
| 文件头注释 + `Tui` 类型 + `return` | 对外 API |
| `inbox` / `waiters` / `readLine` / `submit` | editor 常开；Enter 进队列，不堵键盘 |
| `decodeKey` + `onKey` | `parseKey` + `EDITOR` 绑定；插入 `isCharKey`；退出、编辑、Esc 分层 |
| `matches` + `setLookup` + `submenu` | `/` 命令列表；`/model` `/provider` 二级；`current` → `●` + 加粗 |
| `paint` | 一帧 = transcript 视口 + palette + 框 + footer；和 `prevFrame` 逐行比 + CSI 2026 |
| `pick` / `ask` | setup 挂底栏；`wizard` 接管按键，不 pause |
| `echoUser` / footer | 忙时 `queued ❯`；`inbox.length` → `queued N` |
| `pause` / `resume` | 留给非 TUI form；setup 不再用 |

退出和打断（只在 `onKey` 里；没有 Ctrl+D）：

- Ctrl+C：有字清空 → 向导取消 → busy 打断 → 空闲 `close`
- Esc：向导取消 → 二级列表往回退 → busy 打断（不丢队列）→ 清空
- `/exit` 不在这里，在 `repl.dispatch`

拼键走 `createKeyAssembler`（与 form 同一份）。

---

## 旧文件：只看改了的

### [src/config/index.ts](../src/config/index.ts)

`PRESETS` + `ensureSettings`（开机写空模板）**没了**。

| 新 | 干什么 |
|---|---|
| `CATALOG` | deepseek / kimi / glm。协议和地址写死在代码里 |
| `writeProvider` / `saveSettings` | setup、`/model` 落盘。`saveSettings` 写 `0o600`，目录 `0o700`；chmod 失败忽略 |
| `isProviderReady` | 能 `resolveProvider` 才算能用 |
| `listProviderNames` | **只列 ready 的**，没 key 的 glm 不出现 |
| `listModels` | 只列 settings 里已写入的模型（当前 model ∪ models[]） |
| `fail()` | 只 throw，不再 `process.exit` |
| `auth` | 目录可写；缺省仍是 anthropic→x-api-key，否则 bearer。Kimi 目录写的是 bearer |

字段：CLI > 文件里**写了的** > 目录托底。三家指引故意不写 protocol/baseURL。

### [src/main.ts](../src/main.ts)

- 加了 `ti setup`、`maybeSetup`（当前厂家不能用就先指引）
- TTY → **先 `openTui`，再 `maybeSetup(tui)`**，再 `setProvider` + `repl`（冷启动向导也在底栏）
- `--provider` 直接 `resolveProvider` 用户指定的名字；失败报该名字并退出，不回退 settings、不丢给向导
- 已 `openTui` 之后的退出走 `quit`：先 `tui.close()` 再 `process.exit`
- 非 TTY 仍走旧 readline `repl`

### [src/cli/render.ts](../src/cli/render.ts)

`createTerminalUI(out?)`：可把 `write`/`writeln` 接到 TUI。层次改成工具 `→`、结果再缩进。加了 `bold`。

### [src/llm/index.ts](../src/llm/index.ts) · [openai.ts](../src/llm/openai.ts) · [anthropic.ts](../src/llm/anthropic.ts)

`fetch({ signal })`。流变量 `stopReason` 是 `| undefined`，不默认 `"stop"`；收成内部消息时补 `incomplete` 或 `badArgs`。abort 时有半截内容就 `return` 半截 assistant，完全没数据再抛 `AbortError`。`isAbortError` 在 index。Anthropic `toWire` 把相邻 user 合成一条（文本拼在一起）；`finishInterrupted` 本身没改。

### [src/tools/bash.ts](../src/tools/bash.ts) · [index.ts](../src/tools/index.ts)

`runTool(..., signal?)` → bash 监听 abort → `SIGTERM`（2s 后 `SIGKILL`）。

### [src/tools/edit.ts](../src/tools/edit.ts)

多条对着同一份原文 `indexOf`，区间不得重叠，倒序 `slice` 写回。不是 `replace`，也不是对着改完的 `next` 逐条套。`oldText`、`newText` 必须是 string，缺字段或非字符串就 throw。

### [src/core/agent.ts](../src/core/agent.ts)

循环骨架没变。新逻辑：

- `ctx.signal`：每轮开头、工具前后检查
- `callLLM(..., signal)`；零字节 `AbortError` **不 throw 出循环**，走 `finishInterrupted`
- `finishInterrupted`：未配 toolCall 只 seal，不再追加 interrupted user；否则留下已有内容并 `push user("[interrupted]")`；屏幕 `ui.info("[interrupted]")`
- 流没真实 finish（`incomplete`、`badArgs`）：不跑半截工具，seal 真实原因，屏幕只 `ui.error` 一次，停这一轮
- `toolUse`，或 `stop` 且本条已有完整 toolCall：执行工具。`incomplete`、`badArgs`、`length` 不执行
- 有 toolCall 但不执行（主要是 `length`）：seal 再 continue；连续 3 次停轮
- 流正常结束且无字无工具：不写空 assistant
- token 行：每次 LLM 返回都打（usage 全 0 则跳过）；不再只在「刚跑完工具」时打

### [src/cli/repl.ts](../src/cli/repl.ts)

从「readline + `/model` 改字符串」变成命令中枢。

新/改：

- `COMMANDS` + `setLookup`：TUI 里 `/model` `/provider` 展开二级列表，提交的是 `/model <id>`
- `/cost` `/help`；未知 `/xxx` 不再当用户消息发给模型
- `lastTurn` + `footerText`
- TUI 循环：`readLine` 与 `agentTurn` 重叠（editor 不关）；聊天时 `setBusy` + `AbortController`；`onInterrupt` → `abort()`
- 失败 pop：push user 后记长度，没多出 assistant 才 pop。abort 不会进这个 catch
- 无参 `/model` `/provider`：有 TUI 时**不再** `pause`+`select`（避免画到屏顶）
- `/setup` 直接 `runSetup(tui)`，底栏向导，不 pause
- 非 TTY 后半截还是 readline，行为接近 0.0.2

---

## 一条路径串起来（只串新接头）

```
main → openTui → maybeSetup(tui) → setup pick/ask（底栏）
     → setProvider → repl.setLookup / setFooter
用户 /model → tui 二级列表（不进 form）
用户 /setup → 同一套底栏向导；已有 key 跳过 key 页
用户 Enter 一句话
  tui.submit → echo ❯（忙则 queued ❯）→ inbox → dispatch push user
  setBusy + signal → agentTurn(callLLM signal)
  流式 render → tui.write → paint 差分
  Esc → interrupt → fetch/bash 停 → finishInterrupted（队列还在）
  footer 更新 turn/session / queued N
```

模型在跑时再 Enter：进 `inbox`，**等本轮结束**才 `dispatch`，不会插入当前 turn。

---

## 过关题（只问这次的差异）

1. 为什么三家 setup 不写 protocol/baseURL？文件里若写了会怎样？
2. `listProviderNames` 为什么不列出目录里的 glm（没配 key 时）？
3. TUI 下打 `/model` 为什么看不到屏顶 Model 框？`setLookup` 返回的 `name` 谁消费？
4. abort 发生在「assistant 已带 toolCall、工具还没跑」时，`finishInterrupted` 往 `messages` 里补什么、不补什么？为什么？
5. `paint` 何时整帧、何时改几行？`pause` 后为什么必须丢掉 `prevFrame`？
6. 忙的时候又 Enter 了一句，这句话什么时候进 `messages`？画面上怎么和当前轮区分？
7. 已配过 DeepSeek 再 `/setup` 加一个模型，为什么不再问 API key？换 key 呢？

---

## 仍然没有（代码里找不到是正常的）

session / `-c` / `--resume`、`/compact`、skills、历史落盘、冒烟测试。
工具直接执行，没有权限确认。
