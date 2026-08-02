# ti — 极简 coding agent（参考 pi）

单文件 TypeScript 实现的 coding agent，架构照搬 [pi](https://github.com/badlogic/pi-mono)（现 earendil-works/pi）：

- **agent loop**：流式请求 LLM → 执行 tool_use → tool_result 回灌 → 直到模型不再调用工具
- **4 个工具**（参数与 pi 一致）：`read`（行号+分页）、`write`（自动建父目录）、`edit`（精确替换，oldText 必须唯一，全部针对原文件校验）、`bash`（超时+输出截断+退出码）
- **极简系统提示词**（<1k tokens）：工具一句话说明 + guidelines + cwd + 日期；自动加载 `AGENTS.md`/`CLAUDE.md`
- **pi 同款保护**：`max_tokens` 截断的响应里的工具调用一律报错回灌，不执行
- 零 npm 依赖，SSE 流式输出，多轮 REPL + 单发模式

有意省略（pi 有但超出行数预算）：扩展系统、skills、MCP、权限弹窗、plan mode、子 agent、session 持久化、并行工具执行、中断恢复。

## 运行

需要 Node ≥ 22.6（原生 type-stripping，无需构建；推荐 Node 26）。

```bash
# 鉴权（二选一）+ 可选的兼容端点
export ANTHROPIC_AUTH_TOKEN=...        # -> Authorization: Bearer
export ANTHROPIC_API_KEY=...           # -> x-api-key
export ANTHROPIC_BASE_URL=https://api.kimi.com/coding/   # 可选，默认 api.anthropic.com
export ANTHROPIC_MODEL=k3              # 可选，默认 k3

node agent.ts                          # 交互 REPL（/clear 清空上下文，/exit 退出）
node agent.ts -p "创建一个 hello.txt"    # 单发模式
node agent.ts -m claude-sonnet-4-6 "..." # 指定模型（位置参数也可直接跟 prompt）
```

## 文件

| 文件 | 说明 |
|---|---|
| `agent.ts` | 全部实现（~490 行含详细中文注释）：配置/系统提示词/工具/SSE/loop/REPL |
| `ARCHITECTURE.md` | 架构文档：分层图、agent loop 流程图、时序图、与 pi 的对应关系 |
| `package.json` | `type: module` + `npm start` |
