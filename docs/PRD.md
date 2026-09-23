# ti 产品需求与技术方案文档（PRD）

> 初版需求 · 日期：2026-08-16（2026-08-18 范围冻结）· 2026-09-16 与当前实现对照
> 包名：`@tmjwjx/ti`（scoped，bin 命令 `ti`）· 仓库：github.com/tmjwjx/ti（暂私有，发布时转公开）
> 已落地与未做以本文 4.1 / 4.2 进度为准；详细设计见 `docs/DESIGN.md`；包号与发版对照见 `docs/VERSIONS.md`

## 1. 背景与参考对象

ti 是一个极简 coding agent CLI，设计主要参考三个开源项目：

| | **pi**（badlogic/pi-mono） | **Codex**（openai/codex） | **DeepSeek Harness (dsh)** |
|---|---|---|---|
| 定位 | 极简但可扩展的终端 coding agent | OpenAI 官方终端 coding agent | 「Model + Harness = Agent」的 agent 运行时 |
| 打包 | npm `@mariozechner/pi-coding-agent`，bin→`dist/cli.js`，tsc 构建，~23 个依赖 | npm `@openai/codex`：JS 启动器 + 分平台原生二进制（Rust 内核） | npm `@deepseek-ai/dsh`，pnpm monorepo，Cordis 插件框架 |
| 核心 | 4 工具（read/write/edit/bash）+ <1k tokens 系统提示词 + TS 扩展/skills | 沙箱、审批、MCP、session resume、TUI | 一切皆插件；Standard/PTC/Minimal/Creator 四模式；Web UI + headless |
| 刻意不做 | MCP、子 agent、权限弹窗、plan mode、内置 todo | 不走极简：功能按官方产品铺开 | 完整终端 TUI（CLI 只做启动器，交互在 Web） |

**ti 的取舍**：取 pi 的「极简内核」（agent loop + 4 工具 + 小提示词）、dsh 的「多协议、配置化」，以及 Codex 的会话按项目隔离和 resume 交互。刻意保持**零运行时依赖**，开发模块化、发布打成单文件。不取 Codex 的 Rust 全家桶、沙箱、审批、MCP，也不做插件框架与 Web UI。

## 2. 产品定位与目标

**一句话**：`npm i -g @tmjwjx/ti` 装完即用的极简 coding agent，零运行时依赖、双协议（Anthropic / OpenAI 兼容），面向想读得懂源码的开发者。

**初版目标**：基本可用——日常真实编码任务可以全程在 ti 里完成，不掉链子（会话可恢复、可中断、上下文可压缩）。

**非目标（YAGNI，明确不做）**：插件/扩展系统、Web UI、MCP、子 agent、PTC 模式、主题系统、内置 todo 工具（用 TODO.md 文件代替，pi 哲学）；权限确认（工具直接执行，没有 ask）。skills 只做本地目录扫描的基础机制，不做市场或包分发。

## 3. 目标用户与场景

- 想学习「coding agent 原理」的开发者：模块化源码、中文注释、架构文档齐全
- 用国产模型端点（Anthropic 或 OpenAI 兼容协议）的开发者
- 场景：在某个项目目录里 `ti` 启动 → 自然语言派活（读代码、改 bug、写脚本、跑测试）→ 可中断当前 turn → `--resume` 或 `/resume` 接上。上下文可经 `/compact` 或自动压缩收短

## 4. 功能需求

### 4.1 已落地

agent loop（流式请求→完整 toolCall 才执行→结果回灌→循环）；4 工具（read/write/edit/bash）；双协议（Anthropic Messages / OpenAI chat completions）；`AbortSignal` 贯穿 fetch 与 bash；`finishInterrupted` 中断收尾；流失败（`incomplete` / `badArgs`）停轮；`length` 截断 seal 最多 3 次；`CATALOG`（deepseek / kimi / glm）+ `~/.ti/settings.json`（CLI > 文件里写了的字段 > 目录托底；不读 env）；settings 目录 `0o700`、文件 `0o600`；`--provider` 失败即退出；TTY 主屏 TUI + 非 TTY readline；斜杠 `/clear` `/resume` `/rename` `/model` `/provider` `/setup` `/cost` `/help` `/exit`；底栏 setup 向导；工具直接执行，没有权限确认；AGENTS.md/CLAUDE.md 自动注入；每轮 token + `/cost` 会话累计；`<cwd>/.ti/sessions/*.jsonl` 持久化，`--resume` 与 `/resume` 只列当前目录。

### 4.2 初版范围（进度对照）

| 功能 | 进度 | 描述 | 验收标准 |
|---|---|---|---|
| **session 持久化与恢复** | 已落地 | 消息（含工具结果与 token）写入 `<cwd>/.ti/sessions/<首句 slug>_<4hex>.jsonl`；`ti --resume` 与 `/resume` 只列当前目录。没有 `-c` | 杀掉进程后 `--resume` 或 `/resume` 能完整接续；A、B 项目互不可见；session 文件可直接 `cat` |
| **中断** | 已落地 | agent 执行期间 Ctrl+C 或 Esc 中断当前 turn（AbortSignal 贯穿 fetch 与 bash），回到提示符不退出。工具阶段被打断：没跑的工具补错误结果。请求中被打断：存 `stopReason: "aborted"`，发请求时整条跳过。屏幕 `ui.info("[interrupted]")`。空闲时 Ctrl+C 退出（见 4.4 与 DESIGN.md 中断一节） | 长跑 bash 命令能被打断；被打断的 turn 协议合法，屏幕出现 `[interrupted]` |
| **权限确认** | 不做 | 工具直接执行，没有权限确认。ask 方案见 DESIGN.md 权限一节，不是交付项 | 调用工具时立即执行，终端不出现确认 |
| **/compact 上下文压缩** | 已落地 | 手动 `/compact`、用量超过阈值时自动压、上下文超限时压一次并重试。保留最近一段原文，更早的换成固定分段摘要。`glm-5.3-flash` 没有窗口值，不自动压 | 压缩后屏幕有 `compacted · A → B tokens`；`--resume` 能接上摘要和保留段 |
| **输入体验** | 已落地 | `--resume` / `/resume` 时把该会话里用户发过的消息灌进 ↑ 历史（不单独存文件，pi 同款）；支持 `\` 续行多行输入；`/help` 列出快捷键。前提是摘要与中断不再伪装成用户消息（照 pi：摘要是独立角色，中断标在被打断的回复上）；压缩 prompt 同时换成 pi 的，摘要后附文件清单 | 恢复会话后按 ↑ 能翻出该会话里发过的消息，且不含 `[interrupted]` 和摘要；`a\` 回车再 `b` 回车，模型收到两行 |
| **token 会话累计** | 已落地 | 从 `messages` 累计 in/out 与调用次数；`/cost` 查看（只统计 token，不做金额——价格表易过时，金额留到初版之后） | `/cost` 显示累计 in/out token 与会话轮数 |
| **npm 打包就绪（不发布）** | 部分 | 现状：`scripts/build.mjs`（esbuild minify）→ `bin/ti.js`，`bin:{"ti":"bin/ti.js"}`，`files:["bin"]`，`engines` Node ≥22.18，MIT LICENSE。开发 `npm start` 直跑 `src/`。仍缺：英文优先 README、`npm test` 冒烟 | `npm pack --dry-run` 仅含白名单文件、包体 <100KB；`npm i -g` 后 `ti` 在 Node 22.18+ 可用 |
| **冒烟测试** | 未做 | `scripts/smoke.mjs`：内置 mock server（OpenAI 协议）+ 罐头 SSE，跑通「工具调用全链路、配置优先级、`/model`」断言；`npm test` 可跑 | 无真实 API key 时 `npm test` 全绿 |
| **skills** | 已落地 | 启动时扫描项目 `.ti/skills/*/SKILL.md` 与 `~/.ti/skills/*/SKILL.md`（同名项目级优先），手写解析 frontmatter，不引 yaml 库；清单（名称、描述、路径）追加进系统提示词，模型按需用现有 read 工具读全文——渐进披露，pi 同款。`/名字 参数` 手动调用（内置命令优先），全文直接进这一轮；`/skills` 列出已加载的与警告 | 放一个 SKILL.md 到 skills 目录后，agent 能在对话中识别并正确按技能指示行动；`/名字` 调用时请求里带上该 skill 全文 |
| **/provider 命令** | 已落地 | REPL 内 `/provider` 列出已就绪 provider；`/provider <name>` 整套切换。TUI 下无参展开二级列表。`/model` 只切已写入的模型名 | 不重启即可在已配置的厂家间切换 |

### 4.3 初版之后的候选

extensions（`~/.ti/extensions/*.ts` 注册自定义工具，参考 pi）；cost 金额统计（内置可配置价格表）；`/init` 生成 AGENTS.md；bash 后台任务；粘贴多行优化；PTC 模式调研（dsh）。

### 4.4 TUI（2026-09 已落地 / 待做）

**已落地**

- footer：`provider:model · cwd · turn ↑↓ · session ↑↓`；模型在跑时右侧 `esc interrupt`，有排队则 `queued N`
- 每轮 LLM 调用后 transcript 打 token；`/cost` 看会话累计
- 输入 `/` 出命令列表，↑↓ 选，Tab 补全，Enter 提交；`/model` `/provider` 二级
- editor：Ctrl+A/E 行首尾，Ctrl+U/K 删到行首/行尾，Ctrl+H 删前一字，Delete 删后一字，Ctrl+B/F 左右，Ctrl+P/N 上下，Ctrl+←/→ 按词跳，Home/End，Shift+Enter 换行；插入走 `isCharKey`（按码点，emoji 能进）。没有 Ctrl+D
- 模型在跑时 editor 仍可输入；Enter 排队等本轮结束再发；半截 CSI 或 SS3 等 40ms，超时丢掉、不重放
- PageUp/PageDown 滚视口
- 退出和打断只走 Ctrl+C：有字清空，向导取消，busy 打断，空闲退出；Esc：向导取消 → 二级往回退 → busy 打断（不丢队列）→ 清空；`/exit` 退出
- 重绘：行级 diff + CSI 2026，不再每帧 `\x1b[H\x1b[J`
- transcript：用户 `❯`、工具 `→` 缩进、结果再缩进、token 单独一行

**待做（这次没做，避免把 TUI 做成第二套框架）**

- 主屏真·追加滚动（现在仍是视口钉底栏，只是少闪）；可选 fullscreen / 备用屏
- 当前 turn 中途插入 steering（现在排队的消息等本轮结束才发给模型）
- 括号粘贴（bracketed paste）、`@` 文件、Tab 路径补全
- 鼠标滚轮 / 选中复制的应用层处理
- `/cost` 金额（价格表易过时）

## 5. 非功能需求

- **零运行时依赖**：只用 Node 标准库。devDependency 仅 `@types/node` 与发布用 esbuild
- **体积**：包 <100KB；冷启动 <300ms
- **兼容**：Node ≥22.18（开发 type-stripping 免 flag；与 dsh 的 ^22.19/>=24 同代际）
- **安全**：工具直接执行，没有权限确认；apiKey 只写 `~/.ti/settings.json`（文件 `0o600`，目录 `0o700`）；bash 无沙箱（文档明示风险，同 pi）
- **可维护**：`src/` 模块化拆分（按层分文件、单职责，详见 DESIGN.md §2；不设行数硬指标，职责清晰为准）；开发直跑 `src/main.ts`，发布入口 `bin/ti.js`

## 6. 技术方案

### 6.1 架构（在现有四层上增量）

```
配置层  CATALOG + ~/.ti/settings.json + CLI     （已落地；不采用环境变量的值）
交互层  TUI / readline  REPL                     （已落地：中断、/cost、/provider）
循环层  agentTurn                                （已落地：AbortSignal、finishInterrupted）
传输层  callLLM 双协议                           （已落地：fetch(signal)、usage）
工具层  runTool 4 工具                           （已落地：bash 接 AbortSignal）
待加    冒烟测试、打包余项
```

- **session**：`<cwd>/.ti/sessions/*.jsonl`。`--resume` 与 `/resume` 只列当前目录。没有 `-c`
- **中断**：每轮聊天一个 `AbortController`，经 `ctx.signal` 贯穿 fetch 与 bash；TUI 空 Ctrl+C 或 Esc 在 busy 时 `abort()`；`finishInterrupted` 收尾
- **权限**：工具直接执行，没有权限确认。不设确认钩子，也不弹 ask
- **/compact**：messages 另发一次请求求摘要 → `messages = [{role:"user", content: 摘要+接续指令}]`
- **skills**：启动时 `loadSkills()` 扫描 `.ti/skills/` 与 `~/.ti/skills/`，清单交给 `buildSystemPrompt()`；`/名字` 存成 `skill` 角色，发请求时翻成 user（详见 `docs/impl/skills.md`）
- **/provider**：复用 `resolveProvider()`，REPL 内列出或切换 provider；`/model` 只管已写入的模型名

### 6.2 npm 打包

开发直跑源码；发布打成一份 minify 的 `bin/ti.js`（hashbang 由构建写入）。

```jsonc
{
  "name": "@tmjwjx/ti",
  "bin": { "ti": "bin/ti.js" },
  "engines": { "node": ">=22.18.0" },
  "files": ["bin"],
  "scripts": {
    "start": "node src/main.ts",
    "build": "node scripts/build.mjs",
    "prepublishOnly": "npm run build"
  },
  "license": "MIT"
}
```

发布流程（届时）：仓库转公开 → `npm login` → `npm publish --access public`（scoped 首次必须带）→ git tag。当前已能 `npm pack` 或全局安装；打包还缺英文 README 与冒烟。

### 6.3 目录结构

```
src/                # 分层源码（完整树见 ARCHITECTURE.md；目标增量见 DESIGN.md §2）
  main.ts           # 唯一入口（参数、向导、装配）
  types.ts          # 领域模型（纯类型）
  cli/              # tui.ts · repl.ts · render.ts · keys.ts · form.ts · setup.ts
  core/             # agent.ts · session.ts · prompt.ts
  llm/              # index.ts · sse.ts · anthropic.ts · openai.ts
  tools/            # index.ts · read/write/edit/bash.ts · truncate.ts
  config/           # index.ts（CATALOG + settings.json）
package.json        # bin→bin/ti.js / engines / files / license
README.md           # npm 简介
LICENSE(MIT)
docs/               # PRD.md（本文档）· DESIGN.md · ARCHITECTURE.md · READING.md · VERSIONS.md
scripts/build.mjs   # 发布构建
```

初版仍待加：`config/paths.ts`、`scripts/smoke.mjs`。不要把权限确认的 `permissions.ts`、`cli/input.ts` 当成交付。

## 7. 里程碑

发版按 `0.0.x`，一个功能一个号。对照表在 `docs/VERSIONS.md`。

初版目标见 §2：日常编码能在 ti 里跑完。待发功能齐了再把 `package.json` 打成 `1.0.0`。

当前已落地：session、`/compact`、中断、输入体验、skills、token 累计、`/provider`、TUI、打包主干。未做：冒烟、打包余项。权限确认不做。

## 8. 开放问题

1. 仓库转公开的时机：初版做完即转，还是发布 npm 时再转？（建议：发布时再转，转之前 README 配截图或 GIF）
2. bin 命令名 `ti` 与既有 npm 包 `ti` 的二进制不冲突（scoped 包互不影响），但若用户机器上已全局装过那个包会撞 PATH——README 里注明即可
3. 是否需要 GitHub Actions CI（跑 smoke 测试 + Node 22/24/26 矩阵）？建议初版之后加，发布前必须有
