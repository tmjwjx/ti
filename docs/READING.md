# 相对 0.0.2 的变更阅读指南

对照点：git `8d9838c`（0.0.2）→ 当前工作区（未发版、未 commit）。
0.0.2 里已经懂的（`types.ts`、工具三件套、`sse.ts`、两家协议主干、`prompt.ts`、agent 主循环骨架）**跳过**。这里只标差异。

本地：`npm start`。别用全局 `ti`。

---

## 没动，不用重读

`src/types.ts` · `src/tools/{read,write,edit,truncate}.ts` · `src/llm/sse.ts` · `src/core/prompt.ts`

`openai.ts` / `anthropic.ts` 的 **toWire / 流式拼块** 没改语义，只在外围加了 `signal` 和 abort 半截返回。协议翻译不用重学。

---

## 建议顺序（只读变更）

新文件整篇读。旧文件按「看哪」读，不要通篇。

```
1. config/index.ts     目录替换预设
2. cli/keys.ts         新 · 按键解码
3. cli/form.ts         新 · 全屏 select/input
4. cli/setup.ts        新 · 首次指引
5. main.ts             装配变了
6. cli/render.ts       UI 可注入 TUI
7. llm/ + tools/bash   只看 signal
8. core/agent.ts       只看 abort / token
9. cli/repl.ts         命令 + TUI 循环
10. cli/tui.ts         新 · 最大块
```

---

## 新文件（四份）

### [src/cli/keys.ts](../src/cli/keys.ts)

按键解码。`parseKey("\\x1b[A")` → `"up"`，`parseKey("\\x03")` → `"ctrl+c"`。
CSI / SS3 / C0 / kitty CSI u / modifyOtherKeys 都在这里。`form` / `tui` 只认名字。
Ctrl+A 是不是行首，不在这层，在 tui 的 `EDITOR`。

### [src/cli/form.ts](../src/cli/form.ts)

全屏控件：`select` / `input`，`\x1b[H\x1b[J` 画在屏顶。`FormAbort` = Esc / Ctrl+C。

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
| `decodeKey` + `onKey` | `parseKey` + `EDITOR` 绑定；退出、编辑、Esc 分层 |
| `matches` + `setLookup` + `submenu` | `/` 命令列表；`/model` `/provider` 二级；`current` → `●` + 加粗 |
| `paint` | 一帧 = transcript 视口 + palette + 框 + footer；和 `prevFrame` 逐行比 + CSI 2026 |
| `pick` / `ask` | setup 挂底栏；`wizard` 接管按键，不 pause |
| `echoUser` / footer | 忙时 `queued ❯`；`inbox.length` → `queued N` |
| `pause` / `resume` | 留给非 TUI form；setup 不再用 |

退出（只在 `onKey` 里）：

- Ctrl+C：有字清空 → 向导则取消 → 空且 busy 打断 → 空且空闲 `close`
- Ctrl+D：有字删后一字 → 空 `close`（向导时空不退）
- Esc：向导取消 → 二级列表往回退 → busy 打断（不丢队列）→ 清空
- `/exit` 不在这里，在 `repl.dispatch`

---

## 旧文件：只看改了的

### [src/config/index.ts](../src/config/index.ts)

`PRESETS` + `ensureSettings`（开机写空模板）**没了**。

| 新 | 干什么 |
|---|---|
| `CATALOG` | deepseek / kimi / glm。协议和地址写死在代码里 |
| `writeProvider` / `saveSettings` | setup、`/model` 落盘 |
| `isProviderReady` | 能 `resolveProvider` 才算能用 |
| `listProviderNames` | **只列 ready 的**，没 key 的 glm 不出现 |
| `listModels` | 只列 settings 里已写入的模型（当前 model ∪ models[]） |
| `fail()` | 只 throw，不再 `process.exit` |
| `auth` | 目录可写；缺省仍是 anthropic→x-api-key，否则 bearer。Kimi 目录写的是 bearer |

字段：CLI > 文件里**写了的** > 目录托底。三家指引故意不写 protocol/baseURL。

### [src/main.ts](../src/main.ts)

- 删了 `-p` 单发
- 加了 `ti setup`、`maybeSetup`（当前厂家不能用就先指引）
- TTY → **先 `openTui`，再 `maybeSetup(tui)`**，再 `setProvider` + `repl`（冷启动向导也在底栏）
- 非 TTY 仍走旧 readline `repl`

### [src/cli/render.ts](../src/cli/render.ts)

`createTerminalUI(out?)`：可把 `write`/`writeln` 接到 TUI。层次改成工具 `→`、结果再缩进。加了 `bold`。

### [src/llm/index.ts](../src/llm/index.ts) · [openai.ts](../src/llm/openai.ts) · [anthropic.ts](../src/llm/anthropic.ts)

只多两件事：`fetch({ signal })`；abort 时有半截内容就 `return` 半截 assistant，完全没数据再抛 `AbortError`。`isAbortError` 在 index。

### [src/tools/bash.ts](../src/tools/bash.ts) · [index.ts](../src/tools/index.ts)

`runTool(..., signal?)` → bash 监听 abort → `SIGTERM`（2s 后 `SIGKILL`）。

### [src/core/agent.ts](../src/core/agent.ts)

循环骨架没变。新逻辑：

- `ctx.signal`：每轮开头、工具前后检查
- `callLLM(..., signal)`；`AbortError` → `[interrupted]`，**不 throw 出循环**
- 已 push 的 assistant 若带 toolCall，必须 `sealTools` 补 `isError` toolResult（否则下一轮 400）
- token 行：每次 LLM 返回都打（usage 全 0 则跳过）；不再只在「刚跑完工具」时打

### [src/cli/repl.ts](../src/cli/repl.ts)

从「readline + `/model` 改字符串」变成命令中枢。

新/改：

- `COMMANDS` + `setLookup`：TUI 里 `/model` `/provider` 展开二级列表，提交的是 `/model <id>`
- `/cost` `/help`；未知 `/xxx` 不再当用户消息发给模型
- `lastTurn` + `footerText`
- TUI 循环：`readLine` 与 `agentTurn` 重叠（editor 不关）；聊天时 `setBusy` + `AbortController`；`onInterrupt` → `abort()`
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
  Esc → interrupt → fetch/bash 停 → sealTools?（队列还在）
  footer 更新 turn/session / queued N
```

模型在跑时再 Enter：进 `inbox`，**等本轮结束**才 `dispatch`，不会插入当前 turn。

---

## 过关题（只问这次的差异）

1. 为什么三家 setup 不写 protocol/baseURL？文件里若写了会怎样？
2. `listProviderNames` 为什么不列出目录里的 glm（没配 key 时）？
3. TUI 下打 `/model` 为什么看不到屏顶 Model 框？`setLookup` 返回的 `name` 谁消费？
4. abort 发生在「assistant 已带 toolCall、工具还没跑」时，`messages` 里必须多什么？为什么？
5. `paint` 何时整帧、何时改几行？`pause` 后为什么必须丢掉 `prevFrame`？
6. 忙的时候又 Enter 了一句，这句话什么时候进 `messages`？画面上怎么和当前轮区分？
7. 已配过 DeepSeek 再 `/setup` 加一个模型，为什么不再问 API key？换 key 呢？

---

## 仍然没有（代码里找不到是正常的）

session / `-c` / `--resume`、`/compact`、skills、历史落盘、权限 ask、冒烟测试。
