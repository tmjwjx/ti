# ti — 极简 coding agent（参考 pi）

TypeScript 实现的 coding agent，架构照搬 [pi](https://github.com/badlogic/pi-mono)（现 earendil-works/pi）：

- **agent loop**：流式请求 LLM → 执行 tool_use → tool_result 回灌 → 直到模型不再调用工具
- **4 个工具**（参数与 pi 一致）：`read`（行号+分页）、`write`（自动建父目录）、`edit`（精确替换，oldText 必须唯一，全部针对原文件校验）、`bash`（超时+输出截断+退出码）
- **双协议**：Anthropic Messages（官方/Kimi 等）与 OpenAI 兼容（DeepSeek 官方等），内部统一消息格式，可随时切换
- **极简系统提示词**（<1k tokens）：工具一句话说明 + guidelines + cwd + 日期；自动加载 `AGENTS.md`/`CLAUDE.md`
- **pi 同款保护**：`max_tokens` 截断的响应里的工具调用一律报错回灌，不执行
- 零 npm 依赖，SSE 流式输出，多轮 REPL + 单发模式

有意省略（pi 有但暂未实现）：扩展系统、skills、MCP、权限弹窗、plan mode、子 agent、session 持久化、并行工具执行、中断恢复。路线图见 `docs/PRD.md`。

## 运行

需要 Node ≥ 22.18（原生 type-stripping，无需构建；推荐 Node 26）。零依赖，不用 `npm install`。

```bash
node src/main.ts                          # 交互 REPL（或 npm start）
node src/main.ts -p "创建一个 hello.txt"    # 单发模式
node src/main.ts --provider anthropic     # 切换 provider（默认 deepseek）
node src/main.ts -m deepseek-v4-pro       # 同一家 deepseek 下换 Pro
```

## 配置（参考 pi 的 ~/.pi/）

个人配置放在 **`~/.ti/settings.json`**。端点、模型、key、用哪一家都写在这里，不采用环境变量的值。

```jsonc
{
  "provider": "deepseek",
  "providers": {
    "deepseek":  { "apiKey": "sk-..." },
    "anthropic": { "baseURL": "https://api.kimi.com/coding/", "model": "k3", "auth": "bearer", "apiKey": "..." }
  }
}
```

内置预设：

| 预设 | 协议 | 默认 baseURL | 模型（第一项默认） | key |
|---|---|---|---|---|
| `deepseek` | openai | `https://api.deepseek.com` | `deepseek-v4-flash`、`deepseek-v4-pro` | `providers.deepseek.apiKey` |
| `anthropic` | anthropic | `https://api.anthropic.com` | `k3` | `providers.anthropic.apiKey` |

解析优先级（高 → 低）：

```
CLI（--provider / -m）> ~/.ti/settings.json > 内置预设
```

`providers.<name>` 支持：`baseURL`、`model`（覆盖默认）、`models`（`[{ id }]`）、`apiKey`、`auth`（`"bearer"` | `"x-api-key"`）、`protocol`。
也可以在 `providers` 里加自定义名字，然后 `--provider <name>` 使用。

## 使用

**REPL 内命令**：

- `/model` — 查看当前 provider / 模型 / 端点
- `/model anthropic` — 切换 provider（连带其默认模型）；上下文是协议无关的，跨 provider 无缝
- `/model deepseek-v4-pro` — 当前 provider 下换模型
- `/clear` — 清空对话上下文
- `/exit` — 退出

**使用要点**：

1. **cwd 就是 agent 的工作范围**：想让它操作哪个项目，就 `cd` 到那里再启动
2. **没有权限确认**（pi 的设计哲学）：模型发起的 write/edit/bash 会直接执行
3. 工作目录下放 `AGENTS.md` 或 `CLAUDE.md`，内容自动注入系统提示词

## 文件

| 文件 | 说明 |
|---|---|
| `src/` | 全部实现，四层模块化（含详细中文注释）：`cli/`（接口层）→ `core/`（应用/领域层）→ `llm/`+`tools/`+`config/`（适配层）→ `types.ts`（纯类型），入口 `src/main.ts`。详见 `docs/DESIGN.md` §2 |
| `docs/READING.md` | 代码观看顺序与阅读指南（从 `src/` 现状读起） |
| `docs/ARCHITECTURE.md` | 架构文档：分层图、agent loop 流程图、时序图、与 pi 的对应关系（v0.1 归档） |
| `docs/` | `PRD.md`（v1.0 需求）· `DESIGN.md`（详细设计，含尚未实现的文件） |
| `package.json` | `type: module` + `npm start` |
