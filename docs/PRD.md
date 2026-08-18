# ti 产品需求与技术方案文档（PRD）

> 版本：v1.0 草案 · 日期：2026-08-16 · 状态：待评审
> 包名：`@tmjwjx/ti`（scoped，bin 命令 `ti`）· 仓库：github.com/tmjwjx/ti（暂私有，发布时转公开）

## 1. 背景与参考对象

ti 是一个极简 coding agent CLI，设计主要参考两个开源项目：

| | **pi**（badlogic/pi-mono） | **DeepSeek Harness (dsh)** |
|---|---|---|
| 定位 | 极简但可扩展的终端 coding agent | 「Model + Harness = Agent」的 agent 运行时 |
| 打包 | npm `@mariozechner/pi-coding-agent`，bin→`dist/cli.js`，tsc 构建，~23 个依赖 | npm `@deepseek-ai/dsh`，pnpm monorepo，Cordis 插件框架 |
| 核心 | 4 工具（read/write/edit/bash）+ <1k tokens 系统提示词 + TS 扩展/skills | 一切皆插件；Standard/PTC/Minimal/Creator 四模式；Web UI + headless |
| 刻意不做 | MCP、子 agent、权限弹窗、plan mode、内置 todo | 完整终端 TUI（CLI 只做启动器，交互在 Web） |

**ti 的取舍**：取 pi 的「极简内核」（agent loop + 4 工具 + 小提示词）与 dsh 的「多协议、配置化」，刻意保持**零运行时依赖、单文件**，不做插件框架与 Web UI。

## 2. 产品定位与目标

**一句话**：`npm i -g @tmjwjx/ti` 装完即用的极简 coding agent，单文件、零依赖、双协议（Anthropic / OpenAI 兼容），面向想读得懂每一行源码的开发者。

**v1.0 目标**：基本可用——日常真实编码任务可以全程在 ti 里完成，不掉链子（会话可恢复、可中断、危险操作有确认、上下文可压缩）。

**非目标（YAGNI，明确不做）**：插件/扩展系统、Web UI、MCP、子 agent、PTC 模式、主题系统、内置 todo 工具（用 TODO.md 文件代替，pi 哲学）。skills 只做本地目录扫描的基础机制（F9），不做市场/包分发。

## 3. 目标用户与场景

- 想学习「coding agent 原理」的开发者：单文件、逐行中文注释、架构文档齐全
- 用国产模型端点（DeepSeek/Kimi 等 Anthropic 或 OpenAI 兼容协议）的开发者
- 场景：在某个项目目录里 `ti` 启动 → 自然语言派活（读代码、改 bug、写脚本、跑测试）→ 中断/恢复/压缩上下文 → 退出后会话仍在

## 4. 功能需求

### 4.1 已完成（v0.1 现状）

agent loop（流式请求→工具执行→结果回灌→循环）；4 工具（read/write/edit/bash，参数对齐 pi）；双协议（Anthropic Messages / OpenAI chat completions）；max_tokens 截断保护；配置体系（CLI > env > `~/.ti/settings.json` > 内置预设）；REPL（`/model` `/clear` `/exit`）+ 单发模式；AGENTS.md/CLAUDE.md 自动注入；token 每轮统计。

### 4.2 v1.0 新增（基本可用必备）

| # | 功能 | 描述 | 验收标准 |
|---|---|---|---|
| F1 | **session 持久化与恢复** | 消息历史实时追加写入 `~/.ti/sessions/<cwd目录名>-<时间戳>.jsonl`（首行 meta：cwd/provider/model/创建时间）；`ti -c/--continue` 继续当前目录最近一次会话；`ti --resume` 列出最近会话选择 | 杀掉进程后 `ti -c` 能完整接续上下文；session 文件可直接 `cat` 阅读 |
| F2 | **中断** | agent 执行期间按 Esc/Ctrl+C 中断当前 turn（AbortController 贯穿 fetch 与 bash spawn），回到提示符不退出；空闲时 Ctrl+C 退出 | 长跑 bash 命令能被打断；被打断的 turn 以「已中断」标记写入历史，loop 状态合法 |
| F3 | **权限模式（默认 auto，pi 风格）** | 默认不打扰：所有工具直接执行（与 pi 一致）；配置 `permissions:"ask"` 或启动加 `--ask` 才启用确认——write/edit/bash 执行前弹 `y` 本次 / `a` 本会话同类放行 / `n` 拒绝（错误回灌模型）；`read` 永远免确认；非 TTY（管道）无法提问时按拒绝处理并提示 | 默认全程无确认；ask 模式下 write/bash 必先弹确认；拒绝后模型收到权限错误并调整 |
| F4 | **/compact 上下文压缩** | 把当前消息历史发给模型生成结构化摘要（已完成事项/改动文件/关键决策/待办），替换为单条摘要消息继续会话；原始历史保留在 session 文件 | 压缩后 token 数显著下降；模型能基于摘要正确接续工作 |
| F5 | **输入体验** | readline 历史持久化到 `~/.ti/history`（上限 1000 条）；支持 `\` 续行多行输入 | 重启后方向键↑能翻出上次会话的命令 |
| F6 | **token 会话累计** | 每轮已有统计基础上加会话累计；`/cost` 查看（只统计 token，不做金额——价格表易过时，金额留到 v1.1） | `/cost` 显示累计 in/out token 与会话轮数 |
| F7 | **npm 打包就绪（不发布）** | 方案 A：shebang + `bin:{"ti":"./agent.ts"}` + `engines:{"node":">=22.18.0"}` + `files` 白名单 + MIT LICENSE + 英文优先 README（保留中文小节）；`npm pack` 检查产物；全局安装自测 | `npm pack --dry-run` 仅含白名单文件、包体 <100KB；`npm i -g` 后 `ti -p "..."` 在 Node 22.18+ 可用 |
| F8 | **冒烟测试** | `scripts/smoke.mjs`：内置 mock server（OpenAI 协议）+ 罐头 SSE，跑通「工具调用全链路 / 配置优先级 / /model」断言；`npm test` 可跑 | 无真实 API key 时 `npm test` 全绿 |
| F9 | **skills** | 启动时扫描 `~/.ti/skills/*/SKILL.md` 与项目 `.ti/skills/*/SKILL.md`，解析 frontmatter 的 name/description（手写两行解析，不引 yaml 库），把技能清单（名称+一句话）追加进系统提示词；模型按需用现有 read 工具读取完整 SKILL.md——渐进披露，pi 同款机制 | 放一个 SKILL.md 到 skills 目录后，agent 能在对话中识别并正确按技能指示行动 |
| F10 | **/provider 命令** | REPL 内 `/provider` 列出全部可用 provider（内置预设 + settings.json 自定义，标注当前）；`/provider <name>` 整套切换（baseURL/key/默认模型）；分工明确：/provider 换配置、/model 只换模型名 | 不重启即可在 deepseek / anthropic / 自定义配置间切换 |

### 4.3 v1.1+ 候选（明确排在 v1.0 之后）

extensions（`~/.ti/extensions/*.ts` 注册自定义工具，参考 pi）；cost 金额统计（内置可配置价格表）；`/init` 生成 AGENTS.md；bash 后台任务；粘贴多行优化；PTC 模式调研（dsh）。

## 5. 非功能需求

- **零运行时依赖**：只用 Node 标准库；devDependency 也不引入（测试用内置 mock）
- **体积**：包 <100KB；冷启动 <300ms
- **兼容**：Node ≥22.18（type-stripping 免构建的最低版本；与 dsh 的 ^22.19/>=24 同代际）
- **安全**：默认权限确认（F3）；apiKey 只读 env 或 `~/.ti/settings.json`（文档建议 chmod 600）；bash 无沙箱（文档明示风险，同 pi）
- **可维护**：v1.0 保持单文件 + 分区注释；若超 ~1200 行则按「配置/协议/工具/交互」拆 4 个文件，bin 入口不变（打包方案不受影响）

## 6. 技术方案

### 6.1 架构（在现有五层上增量）

```
配置层  ~/.ti/settings.json + env + CLI        （现状，不变）
交互层  REPL + 单发    → 加：中断处理、历史持久化、权限提问、/compact /cost
循环层  agentTurn      → 加：AbortSignal 贯穿、beforeToolCall 权限钩子、session 追加写
传输层  callLLM 双协议 → 加：fetch(signal)、usage 累计
工具层  runTool 4 工具 → 加：bash 接 AbortSignal（kill 进程）
```

- **session 格式（JSONL，线性）**：首行 `{"type":"meta","version":1,"cwd","provider","model","createdAt"}`，之后每行一条 `{"type":"message","role","content"}`；恢复时读文件重建 `messages[]`
- **中断**：`AbortController` 每 turn 一个；readline `SIGINT` 事件触发 abort（而非默认杀进程）；bash 监听 signal → `child.kill()`
- **权限**：循环层加 `beforeToolCall(name, input) → allow | always | deny` 钩子（对齐 pi 的钩子位）；默认 auto 直通，ask 模式才触发终端提问；`always` 记入内存集合
- **/compact**：messages 另发一次非流式请求求摘要 → `messages = [{role:"user", content: 摘要+接续指令}]`
- **skills（F9）**：`buildSystemPrompt()` 时扫描 `~/.ti/skills/` 与 `.ti/skills/`，frontmatter 手写解析 name/description 两行（不引 yaml 库），清单注入系统提示词
- **/provider（F10）**：复用 `resolveProvider()`，REPL 内列出/切换 provider；`/model` 收敛为只管模型名

### 6.2 npm 打包（方案 A：单文件直发，不构建）

```jsonc
{
  "name": "@tmjwjx/ti",
  "bin": { "ti": "./agent.ts" },        // agent.ts 顶部加 #!/usr/bin/env node
  "engines": { "node": ">=22.18.0" },   // type-stripping 免 flag 的最低版本
  "files": ["agent.ts", "ARCHITECTURE.md", "docs"],
  "license": "MIT"
}
```

发布流程（届时）：仓库转公开 → `npm login` → `npm publish --access public`（scoped 首次必须带）→ git tag。当前阶段只做到 `npm pack` + 全局安装自测。

### 6.3 目录结构（v1.0 目标）

```
agent.ts            # 单文件全部逻辑（shebang；超 ~1200 行才拆分）
package.json        # bin/engines/files/license
README.md           # 英文优先 + 中文小节（面向 npm 页面）
ARCHITECTURE.md     # 架构文档（现状已有）
LICENSE             # MIT
docs/PRD.md         # 本文档
scripts/smoke.mjs   # mock 冒烟测试（F8）
```

## 7. 里程碑

| 版本 | 内容 | 退出条件 |
|---|---|---|
| v0.1 ✅ | 核心 loop + 4 工具 + 双协议 + 配置（现状） | 已完成并验证 |
| v0.2 | F1 session + F2 中断 | 杀进程可恢复；长任务可中断 |
| v0.3 | F3 权限（默认 auto）+ F4 compact + F5 历史 + F6 token 累计 | 验收标准全过 |
| v0.4 | F9 skills + F10 /provider | 验收标准全过 |
| v1.0 | F7 打包就绪 + F8 冒烟测试 + 英文 README + 打磨 | `npm pack` 自测通过、`npm test` 全绿；**不发布** |
| 发布决策点 | 用户确认后：仓库转公开 + `npm publish --access public` | 包可全局安装使用 |
| v1.1+ | 4.3 候选功能按优先级迭代 | — |

## 8. 开放问题

1. 仓库转公开的时机：v1.0 完成即转，还是发布 npm 时再转？（建议：发布时再转，转之前 README 配截图/GIF）
2. bin 命令名 `ti` 与既有 npm 包 `ti` 的二进制不冲突（scoped 包互不影响），但若用户机器上已全局装过那个包会撞 PATH——README 里注明即可
3. 是否需要 GitHub Actions CI（跑 smoke 测试 + Node 22/24/26 矩阵）？建议 v1.0 后加，发布前必须有
