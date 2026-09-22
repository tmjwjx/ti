# 相对 0.0.2 的变更阅读指南

对照点：`package.json` 0.0.2 → 0.0.3。
0.0.2 里已经懂的（TUI、setup、`finishInterrupted`、两家协议、`/cost`）**跳过**。这里只标 session 这一刀。

本地：`npm start`。别用全局 `ti`。

---

## 没动，不用重读

`src/llm/*` · `src/tools/*` · `src/cli/tui.ts` · `src/cli/keys.ts` · `src/cli/form.ts` · `src/cli/setup.ts` · `src/config/*` · `src/core/prompt.ts` · `src/types.ts`

TUI 只被复用了已有的 `pick` / `writeln` / `clear`。

---

## 建议顺序（只读变更）

```
1. core/session.ts     新 · 整篇
2. core/agent.ts       只看 push → pushMessage
3. cli/repl.ts         用户句、失败撤回、/clear、/resume、/rename、pickAndResume
4. cli/render.ts       replayMessages
5. main.ts             --resume 插在 setProvider 之后、repl 之前
```

---

## 新文件

### [src/core/session.ts](../src/core/session.ts)

当前项目的对话落盘。模块级一个 `writer`：`null` 就是还没建档。

| 出口 | 干什么 |
|---|---|
| `sessionDir` | `join(cwd, ".ti/sessions")`，不往上找 git 根 |
| `createSession` | mkdir `0o700`，建 `<slug>_<4hex>.jsonl`，先写 meta |
| `openSession` / `bindSession` / `endSession` / `sessionFile` | 指向哪一份 |
| `loadMessages` | 坏行跳过；只取最后一个 compact 之后；补齐缺失 toolResult |
| `listSessions(10)` | 当前目录、mtime 倒序；大文件只读文件头 |
| `pushMessage` | 数组 push；`writer` 为空则先建档；再追一行 |
| `popMessage` | 数组 pop + 文件去掉最后一条 message |
| `renameSession` | 改 `meta.name`，文件换新 slug，hex 后缀保留 |
| `isSessionPath` / `takePersistError` | 路径必须在 sessions 内；落盘失败给界面取一次 |

文件名取首条用户句第一行做 slug（控制字符丢掉，空白和 `/ \ : * ? " < > |` 换 `-`，去头尾点，截 40 字）。覆写 tmp+fsync+rename；同文件 `.lock`。IO 全包 try：磁盘出问题只降级为不落盘，界面提示 `session not saved`。

---

## 旧文件：只看改了的

### [src/core/agent.ts](../src/core/agent.ts)

循环、调度、SSE 一行没动。所有 `messages.push` 换成 `pushMessage`：assistant、toolResult、`[interrupted]`、seal 的错误结果。

### [src/cli/repl.ts](../src/cli/repl.ts)

- 用户句 `pushMessage`；请求失败且还没写出 assistant：`popMessage`
- `/clear` 多调 `endSession()`，旧 jsonl 原地留着
- `/resume` 与 `main.ts --resume` 共用 `pickAndResume`：`listSessions` → `tui.pick`（无 TUI 的 TTY 走 `form.select`，非 TTY 只打印列表）→ `loadMessages` + `bindSession` → `replayMessages`
- 载入的消息用数组就地灌，**不要**再走 `pushMessage`，否则会在旧文件末尾复制一份
- `/rename` 带参改名；不带参提示当前名字

### [src/cli/render.ts](../src/cli/render.ts)

`replayMessages`：按 user / assistant / toolResult 复用现有 render，跳过流式与 token 行。工具输出仍截 5 行。

### [src/main.ts](../src/main.ts)

多认 `--resume`。插在 `setProvider` 之后、`repl()` 之前。help 补一行。

---

## 一条路径串起来

```
首条用户输入
  pushMessage → writer 为 null → createSession（slug 取这一句）→ 追 meta + message
  agentTurn → pushMessage(assistant / toolResult)
退出再起
  ti --resume → pickAndResume → bindSession → replayMessages → repl
对话中 /resume
  messages 就地换成载入的，tui.clear 后再画
/clear
  数组清空 + endSession；下一句用户输入开新文件
```

---

## 过关题（只问这次）

1. 只敲 `/help` 就退出，磁盘上为什么没有文件？
2. `/clear` 之后旧 jsonl 还在吗？下一句进哪一份？
3. 恢复时为什么不按 meta 里的 provider 切换？
4. `pickAndResume` 灌历史为什么不能走 `pushMessage`？
5. 换一个目录跑 `--resume`，为什么看不到刚才那个项目的会话？

---

## 仍然没有（代码里找不到是正常的）

`-c` / `--continue`、启动自动续上一次、跨目录总表、`/resume all`、恢复时切厂家、真 compact、金额、`~/.ti/history`、往上找 git 根。
