# 相对 0.0.6 的变更阅读指南

对照点：`package.json` 0.0.6 → 0.0.7。
这一版主要是加测试，源码只改了测试查出的两处 bug。

本地：`npm test`。

---

## 建议顺序

```
1. docs/DESIGN.md §5      测试怎么做：node:test、单元测试 + 进程内假 fetch 的流程测试、不起子进程、不用真 key
2. test/helpers.ts        临时 HOME 与项目目录、假 fetch 与罐头 SSE、记录事件的 AgentUI
3. src/tools/bash.ts      命令自成进程组，打断、超时、ti 退出时整组杀
4. src/llm/sse.ts         事件与行同时认 \n 和 \r\n
5. test/*.test.ts         按需翻，一个文件对应一块
```

---

## 测试文件

| 文件 | 测什么 |
|---|---|
| `skills.test.ts` | 扫描顺序、去重、警告、frontmatter 各种写法、清单与上限、读全文 |
| `session.test.ts` | 建档命名、半截行、撤回、压缩标记、恢复修补、改名、列表、锁、体积上限 |
| `compact.test.ts` | 估算、阈值、切点、用量可信标记、压缩请求格式、文件清单、失败情形 |
| `agent.test.ts` | 正常回复、工具真跑、流失败、截断重试、四种中断、轮数上限 |
| `openai.test.ts` / `anthropic.test.ts` | 请求格式与回包收拢 |
| `llm.test.ts` | `toLlm`、超限与中断判断、按协议分发 |
| `sse.test.ts` | 帧切分、跨包拼接、CRLF |
| `tools.test.ts` | read、write、edit、bash、截断 |
| `config.test.ts` | 字段优先级、报错、厂家与模型列表、窗口 |
| `repl.test.ts` | 经 `repl()` 加假 Tui 跑斜杠命令、对话、skill、压缩、超限重试、`/resume` |
| `tui.test.ts` | 提交、命令列表、二级列表、Tab、`\` 续行、Shift+Enter、↑↓ 历史、编辑键、向导 |
| `keys.test.ts` | 按键解析、拼键超时 |
| `render.test.ts` | 工具摘要、结果预览、重放 |

---

## 两处修复

- **bash**：以前打断只杀外层 `sh`，`echo x; sleep 3`、`sleep 3 | cat` 里的子进程继续跑，还占着输出，要等它跑完才返回。现在在 POSIX 上每条命令自成一个进程组，杀整组；超时改成自己计时。
- **SSE**：以前只按 `\n\n` 切，`\r\n\r\n` 分隔的流一帧都解析不出来。
