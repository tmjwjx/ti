# 版本与需求

认包号只看 `package.json`。认要做什么看 `docs/PRD.md` 里的功能名。这一页把两者对上。

初版目标（日常编码能在 ti 里跑完、不掉链子）齐了，再把包打成 `1.0.0`。在那之前按 `0.0.x` 走，一个功能一个号。

## 文档

| 文件 | 看什么 |
|---|---|
| `docs/PRD.md` | 要做什么、验收、进度 |
| `docs/DESIGN.md` | 每个功能怎么落地 |
| `docs/ARCHITECTURE.md` | 现在代码怎么分层 |
| `docs/READING.md` | 这一版相对上一版读哪些文件 |
| `docs/VERSIONS.md` | 包号对应哪个功能、发过哪一版 |
| `docs/impl/*.md` | 各功能的实现文档（开发期照着做的大纲） |
| `AGENTS.md` | 开发流程、注释约定 |
| `package.json` | 当前包号 |

设计取舍写进 `DESIGN.md` 对应功能那一节。功能大、开发期要反复照着做的，另开一份实现文档放 `docs/impl/<功能名>.md`（如 `docs/impl/compact.md`），按功能名命名，不用版本号。两处都要人点头再写代码。

## 号怎么走

1. 一个功能对应一个 `0.0.x`。中间可以带点小优化，不另开号。
2. 需求谈清 → 方案写进 DESIGN、点头 → 开发 → CR → `package.json` 写成这一号 → 提交 → 再决定发 npm。
3. 没 CR、没提交，就不发。工作区里的号不算已发。
4. 已经做过的功能不再占新号。明确不做的不进待发列。

## 对照

| 包号 | 功能 | 状态 |
|---|---|---|
| 0.0.1 | 首次能装、能跑 | 已发 npm |
| 0.0.2 | 缩短商店介绍。之后 git 又进了 TUI、中断、`/cost`、`/provider`、打包主干，号没再加，也没再发 | npm 上的 0.0.2 比现在的 `main` 旧 |
| 0.0.3 | session 持久化与恢复 | 已发 npm |
| 0.0.4 | `/compact` 上下文压缩（含自动压缩、超限兜底重试） | 已提交，未发 npm |
| 0.0.5 | 输入体验：恢复会话时回灌 ↑ 历史、`\` 续行、`/help` 快捷键（前提：照 pi 把摘要改成独立角色、中断标成 aborted，压缩 prompt 换成 pi 的） | 已提交，未发 npm |
| 0.0.6 | skills（`/名字` 手动调用、`/skills`；顺带修命令列表回车丢参数、删掉自动改 `.gitignore`） | 已提交，未发 npm |
| 0.0.7 | 测试（顺带修测试查出的 bash 打断不杀子进程、SSE 不认 CRLF） | 已提交，未发 npm |
| 0.0.8 | 打包余项（英文 README 等） | 未做 |
| 1.0.0 | 初版：上表待发齐了 | 未到 |

权限确认明确不做。TUI 里那些加分项（真追加滚动、中途插入、括号粘贴等）不单独占号。初版之后的候选（扩展、金额、`/init` 等）见 PRD §4.3。

## 现在

0.0.3（session）已发 npm，落盘可靠性收口也已提交，没另开号。

0.0.4（`/compact`）已提交，发不发 npm 另说。实现在 `src/core/compact.ts`，说明在 `docs/impl/compact.md`。`glm-5.3-flash` 仍没有窗口值，不自动压。0.0.5（输入体验）已提交，发不发 npm 另说。实现在 `src/cli/tui.ts`、`src/cli/repl.ts`、`src/llm/index.ts` 的 `toLlm`、`src/core/compact.ts`，说明在 `docs/impl/history.md`。0.0.6（skills）已提交，发不发 npm 另说。实现在 `src/core/skills.ts`，说明在 `docs/impl/skills.md`。还没有正式版、没有存量文件，会话格式直接改，不做旧格式兼容。自动往用户项目 `.gitignore` 加 `.ti/` 的逻辑已删掉。0.0.7（测试）已提交，发不发 npm 另说。测试在 `test/*.test.ts`，`npm test` 跑，说明在 `docs/DESIGN.md` §5。顺带修了测试查出的两处：bash 打断或超时不杀子进程、SSE 不认 CRLF。下一号是 0.0.8（打包余项），仍先谈需求再写方案。
