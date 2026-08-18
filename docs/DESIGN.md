# ti v1.0 设计文档

> 版本：v1.0 设计冻结稿 · 日期：2026-08-18 · 对应需求：`docs/PRD.md`（v1.0 范围已冻结）
> 实现约束：模块化 `src/` 目录、零运行时依赖、Node ≥22.18、双协议（Anthropic / OpenAI 兼容）、免构建直发

## 1. 设计原则

1. **模块化单职责**：按层拆分为小文件，每个文件一个明确职责、可独立理解；单文件 ≤ ~250 行，超出说明职责没拆对
2. **零依赖**：只用 Node 标准库（fs/path/os/readline/child_process/crypto）
3. **协议无关内核**：循环层/工具层只面对内部 `Block[]` 消息结构与 `ProviderConf`，新增功能不碰协议转换层
4. **失败就地回灌**：工具/权限/中断的失败都转成 `is_error` 的 tool_result 回灌模型，loop 永不崩溃
5. **状态三处**：对话状态 = `messages[]`（内存）→ `~/.ti/sessions/*.jsonl`（持久化）；配置 = `~/.ti/settings.json`；输入历史 = `~/.ti/history`
6. **免构建**：Node type-stripping 直接运行 `.ts`；相对 import 必须带 `.ts` 扩展名；只用可擦除语法（无 enum/namespace/参数属性）

## 2. 文件架构

```
ti/
├── package.json            # bin → src/main.ts；files 白名单 ["src", "docs", "ARCHITECTURE.md"]
├── agent.ts                # 兼容壳：import "./src/main.ts"（不发布，本地习惯 node agent.ts 不受影响）
├── README.md / ARCHITECTURE.md / LICENSE(MIT)
├── docs/                   # PRD.md（需求）· DESIGN.md（本文档）
├── scripts/
│   └── smoke.mjs           # F8 冒烟测试：内置双协议 mock server + 断言
└── src/
    ├── main.ts             # 入口：shebang、CLI 参数解析、-c/--resume 恢复流程、单发/REPL 分发
    ├── config.ts           # 配置体系：预设、settings.json 加载、resolveProvider()、当前 provider 状态
    ├── types.ts            # Block / Message / ProviderConf / Skill / SessionMeta 等共享类型
    ├── system-prompt.ts    # 系统提示词构建（AGENTS.md/CLAUDE.md 注入 + skills 清单注入）
    ├── skills.ts           # F9：skills 目录扫描 + frontmatter 解析（name/description）
    ├── session.ts          # F1：SessionWriter / loadSession / listSessions / compact 标记
    ├── permissions.ts      # F3：confirmToolCall() + readOneLine()（直读 stdin，不建第二 rl）
    ├── render.ts           # ANSI 颜色、工具参数摘要、结果预览
    ├── agent.ts            # 循环层：agentTurn（abort 贯穿、权限钩子、session 追写、totals 累计）
    ├── repl.ts             # REPL：for-await 循环、斜杠命令、历史持久化、多行续行、/compact
    ├── llm/
    │   ├── index.ts        # callLLM() 协议分发 + LlmResult 类型
    │   ├── sse.ts          # sseJson() 通用 SSE 帧解析（两协议共用）
    │   ├── anthropic.ts    # Anthropic Messages 协议（/v1/messages）
    │   └── openai.ts       # OpenAI 兼容协议（/chat/completions，收发边界格式转换）
    └── tools/
        ├── index.ts        # TOOLS schema 定义 + runTool() 分发
        ├── read.ts         # 各工具单文件实现，对齐 pi 的 tools/ 目录组织
        ├── write.ts
        ├── edit.ts
        └── bash.ts
        └── truncate.ts     # 输出头部截断（2000 行 / 50KB）
```

**职责与依赖规则**（import 单向、无环）：

```
types     ← 纯类型，谁都可引用
config    ← 被 main/repl/agent/llm 引用；拥有 settings 与当前 provider 状态
llm/*     ← 无状态；每次调用接收 ProviderConf 参数（不读全局）
tools/*   ← 无状态；纯函数式实现
session   ← 拥有当前 SessionWriter（首条消息时惰性创建）；暴露 recordMessage()
render    ← 纯展示函数
permissions ← 被 agent 调用；拥有模式(auto/ask)与会话级放行集合
agent     ← 组装者：llm + tools + permissions + session + render；拥有 totals 与 currentAbort
system-prompt ← 被 main 调用一次；依赖 skills
repl/main ← 入口层
```

**全局可变状态只住三处**：`config.ts`（当前 provider）、`session.ts`（当前会话写入器）、`agent.ts`（totals、currentAbort）。其余模块全部无状态，便于测试与日后拆分。

## 3. 功能详细设计

### F1 · session 持久化与恢复

**存储格式**（`~/.ti/sessions/<时间戳>_<4位随机>.jsonl`，时间戳冒号转 `-` 保证文件名合法且可按名称排序）：

```jsonl
{"type":"meta","version":1,"cwd":"/abs/path","provider":"deepseek","model":"deepseek-chat","createdAt":"2026-08-18T08:30:00.000Z"}
{"type":"message","role":"user","content":"帮我改个 bug"}
{"type":"message","role":"assistant","content":[...]}
{"type":"compact","createdAt":"..."}              ← F4 压缩时写入的分隔标记
{"type":"message","role":"user","content":"[摘要] ..."}
```

**接口**：

```ts
interface SessionWriter { file: string; append(msg: Message): void; markCompact(): void; }
function createSession(): SessionWriter            // 首条用户消息时才建文件（避免空 session）
function loadSession(file: string): Message[]      // 逐行 JSON.parse，坏行跳过；
                                                   // 遇最后一个 compact 标记，只取其后消息
function listSessions(limit = 10): Array<{ file: string; meta: any; firstUserText: string; count: number }>
function latestSessionFor(cwd: string): string | null  // 按文件名倒序找首个 meta.cwd 匹配的
```

**写入时机**：模块级 `let session: SessionWriter | null`；所有 `messages.push(...)` 收敛为一个 `pushMessage(msg)` 辅助函数（REPL 输入、agentTurn 内 assistant/tool_result、compact 摘要都走它），内部同步 `session.append()`。追加写用 `appendFileSync`（每行一条、量小，同步写最简单可靠）。

**恢复流程**：`-c/--continue` → `latestSessionFor(cwd)`；`--resume` → `listSessions()` 打印编号列表（时间、cwd、首条用户消息前 60 字、消息数），读序号选择。恢复后打印 `dim` 提示（恢复自哪个文件、多少条消息），然后正常进 REPL/单发。找不到时打印提示并全新开始（不报错退出）。

### F2 · 中断

**机制**：模块级 `let currentAbort: AbortController | null`。`agentTurn` 开始时 `currentAbort = new AbortController()`，结束/异常时置 null。信号贯穿：

- `callLLM` → `fetch(url, { signal })`；abort 时 fetch 抛 AbortError，被捕获后按「部分响应」处理
- bash 工具 → 增加可选 `signal` 参数：`signal.addEventListener("abort", () => child.kill("SIGTERM"))`
- 工具循环每次迭代前检查 `signal.aborted` → 停止后续执行

**协议合法性**（关键设计）：abort 发生时，若已构造的 assistant 消息里含 tool_use 块，则**每个未拿到结果的 tool_use 都补一条** `is_error:true, content:"aborted by user"` 的 tool_result 再入历史——Anthropic 与 OpenAI 两种协议都要求调用必须有结果，否则下一轮请求 400。

**触发**：REPL 里 `rl.on("SIGINT")`——`currentAbort` 非空 → `abort()`（当前 turn 优雅收尾，打印 `[interrupted]`）；为空（空闲）→ 退出进程。**只做 Ctrl+C，不做 Esc**（Esc 需 keypress 级处理，收益低；相对 PRD 的简化点）。单发模式同样挂 `process.on("SIGINT")` → abort。

### F3 · 权限（默认 auto）

**配置**：`settings.json` 顶层 `permissions: "auto" | "ask"`；CLI `--ask` 强制 ask。优先级：`--ask` > settings > 默认 `auto`。

**钩子**：`agentTurn` 执行工具前调用——

```ts
async function confirmToolCall(tu: ToolUse): Promise<"allow" | "deny">
// auto 模式 / read 工具 / 本会话已 "a" 放行的工具名 → 直接 allow
// ask 模式：终端显示  `→ bash  rm -rf build/  [y]允许 [a]本会话放行 [n]拒绝`
//   非 TTY（管道）→ 打印提示并 deny
```

**提问实现**：独立 `readOneLine(prompt): Promise<string>`——直接操作 `process.stdin`（`resume()` + `once("data")`），**不新建第二个 readline 实例**（避免与 for-await 的主 rl 抢流）。调用时主 rl 正处于 await agentTurn、未读 stdin，无竞争。

**拒绝处理**：`deny` → 不执行，结果为 `is_error:true, "Permission denied by user"` 回灌（模型据此换方案）。`a` 放行的工具名存模块级 `Set<string>`，仅本会话有效。

### F4 · /compact

**触发**：REPL `/compact`；`messages.length < 10` → 提示「历史太短，无需压缩」。

**流程**：

1. 构造压缩请求：`[...messages, {role:"user", content: COMPACT_PROMPT}]`（COMPACT_PROMPT 要求输出：已完成事项 / 改动的文件及要点 / 关键决策 / 待办，≤500 字）
2. **复用现有流式 `callLLM`**，`onText` 传空操作（不新增非流式分支）；取响应 text 块拼接为摘要
3. `session.markCompact()` 写分隔标记 → `messages = [{role:"user", content: "[此前对话摘要]\n" + summary + "\n请基于摘要继续。"}]` → 作为新消息追加进 session
4. 打印压缩前后消息条数

恢复时 `loadSession` 只取最后一个 compact 标记之后的消息（见 F1），压缩效果跨进程保留。

### F5 · 输入体验

**历史持久化**：启动读 `~/.ti/history`（不存在则空），按 readline 约定**最新在前**反转后传 `createInterface({ history, historySize: 1000 })`；每接受一条非空非 `/` 命令的输入，`appendFileSync` 追加一行；文件超 1000 行时启动读取阶段截断（取最后 1000 行）。连续重复行不重复写入。

**多行输入**：REPL 循环里，若行以 `\` 结尾 → 去掉 `\`，继续读下一行拼接（提示符变为 `... `），直到不以 `\` 结尾再提交。与 for-await 天然兼容。

### F6 · token 累计与 /cost

模块级 `const totals = { input: 0, output: 0, turns: 0 }`；`agentTurn` 每轮累加 `res.usage`。REPL `/cost` 打印：`session: 12,345 in / 6,789 out · 8 turns`。不含金额（v1.1 再做价格表）。

### F9 · skills

**扫描**：`buildSystemPrompt()` 内同步扫描 `~/.ti/skills/*/SKILL.md` 与 `<cwd>/.ti/skills/*/SKILL.md`（`readdirSync` + `existsSync`，失败静默跳过）。

**frontmatter 解析**：文件以 `---` 开头 → 读到下一个 `---`；只提取单行 `name:` 与 `description:`（手写两行解析，**不引 yaml 库**）；`name` 缺省取目录名。上限 20 个，description 截断 200 字符。

**注入**（pi 同款渐进披露，模型用现有 read 工具按需读全文）：

```
Available skills (when a task matches a skill, read its SKILL.md with the read tool first):
- commit-helper: 生成规范 commit message (~/.ti/skills/commit-helper/SKILL.md)
```

### F10 · /provider 命令

- `/provider`（无参）→ 列出内置预设 + `settings.providers` 自定义项，每项一行：`名称  protocol  baseURL  model`，当前项前缀 `*`
- `/provider <name>` → `provider = resolveProvider(name)`；失败（未知名字/缺 key）打印错误、保持当前不变
- **`/model` 行为收敛**（破坏性变更，README 注明）：`/model` 只查看/切换当前 provider 下的模型名；原来的「参数是 provider 名则切 provider」分支删除，由 `/provider` 接管

## 4. 打包与发布设计（F7）

- `src/main.ts` 第一行加 `#!/usr/bin/env node`（必须位于文件头注释之前）
- `package.json`：

```jsonc
{
  "name": "@tmjwjx/ti",
  "version": "0.2.0",                 // 跟随里程碑，v1.0 时升 1.0.0
  "description": "Minimal coding agent modeled after pi. 极简 coding agent（零依赖、免构建）",
  "type": "module",
  "bin": { "ti": "./src/main.ts" },   // npm 为 bin 建 shim/symlink，node 直接跑 .ts
  "engines": { "node": ">=22.18.0" }, // type-stripping 免 flag 最低版本
  "files": ["src", "ARCHITECTURE.md", "docs"],
  "scripts": { "start": "node src/main.ts", "test": "node scripts/smoke.mjs" },
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/tmjwjx/ti.git" },
  "keywords": ["coding-agent", "llm", "cli", "deepseek", "anthropic"]
}
```

- 新增 `LICENSE`（MIT，copyright tmjwjx）；README 在 v1.0 里程碑改为英文优先 + 中文小节
- 验收：`npm pack --dry-run` 仅含白名单文件且 <100KB；`npm i -g .` 后 `ti --help`、`ti -p` 冒烟可用；**不执行 publish**

## 5. 测试设计（F8）

`scripts/smoke.mjs`：零依赖，内置两个 mock server（OpenAI 协议 + Anthropic 协议，罐头 SSE），用 `child_process` 起 `agent.ts` 子进程并断言 stdout/退出码。场景矩阵：

| # | 场景 | 环境 | 断言 |
|---|---|---|---|
| S1 | OpenAI 协议全链路 | `TI_BASE_URL` 指 mock + 假 key | 输出含 mock 工具结果；mock 侧角色序列 `system→user→assistant+tool_calls→tool` |
| S2 | Anthropic 协议全链路 | `ANTHROPIC_BASE_URL` 指 mock | 同上（content_block 事件流） |
| S3 | 配置优先级 | HOME 隔离 + settings.json vs env | 实际请求的 baseURL/key 符合优先级 |
| S4 | `/model`、`/provider` | 管道输入命令序列 | 输出包含切换后的 provider:model |
| S5 | session 恢复 | 跑一轮 → `-c` 再起 | 第二轮请求 messages 含第一轮历史 |
| S6 | 权限 ask 模式拒绝 | `--ask` + 管道（非 TTY） | 工具被拒、输出含权限提示 |
| S7 | /compact | mock 第二轮返回摘要 | messages 被重置为摘要消息 |

任一断言失败 → 非零退出并打印失败项；全过打印绿字汇总。

## 6. 风险与取舍

| 风险/取舍 | 决策 |
|---|---|
| 模块化拆分引入 import 管理成本 | 约定依赖方向（§2 规则）+ 纯类型/无状态模块为主；拆分本身作为 v0.2 的第一步独立提交（行为不变的纯搬迁，冒烟回归） |
| Ctrl+C 语义改变（REPL 内从「退出」变「中断 turn」） | 空闲时仍退出；启动横幅注明 |
| 权限提问与 for-await 主循环的 stdin 竞争 | readOneLine 直接读 stdin、不建第二 rl 实例；非 TTY 一律 deny |
| session 文件无锁/无压缩 | 单用户单进程工具，线性追加足够；pi 同样从简 |
| compact 用当前 provider 模型 | 不引入额外「小模型」配置，行为可预期 |
| F2 不做 Esc | Ctrl+C 已覆盖场景，Esc 需 keypress 处理复杂度不值 |

## 7. 实施顺序（对应 PRD 里程碑）

| 里程碑 | 内容 | 依赖 |
|---|---|---|
| v0.2 | **R0 拆分重构**（单文件 → §2 的 src/ 结构，行为不变、冒烟回归）→ F1 session + F2 中断 | F1 的 pushMessage 收敛先行；F2 依赖 F1 的协议合法性设计 |
| v0.3 | F3 权限 + F4 compact + F5 历史/多行 + F6 token 累计 | F4 依赖 F1 的 compact 标记；F3 独立于其他 |
| v0.4 | F9 skills + F10 /provider | 只动系统提示词与 REPL，互不依赖 |
| v1.0 | F7 打包 + F8 冒烟测试 + 英文 README + 打磨 | F8 覆盖 v0.2-v0.4 全部场景 |

每个里程碑：实现 → 按 PRD 验收标准实测 → 双语 commit → 推私有仓库。
