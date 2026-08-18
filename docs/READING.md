# ti 代码阅读指南（CR 用）

> 目的：逐行读懂当前实现，建立对项目的完整心智模型。
> 方法：**两遍阅读法**——第一遍顺依赖方向读结构（内→外，建立地图），
> 第二遍跟一次真实请求读数据流（外→内，看零件怎么咬合）。
> 全程约 1-2 小时。配合 `docs/DESIGN.md` §2 的文件架构树食用。

## 第一遍：结构阅读（内 → 外）

### 第 0 站：`docs/DESIGN.md` §2（5 分钟）

只看文件架构树和依赖规则，记住一句话：**依赖只能由外向内**——
`cli/ → core/ → llm/ tools/ config/ → types.ts`。
之后每读一个文件都问一句：「它 import 了谁？符不符合规则？」

### 第 1 站：`src/types.ts`（31 行）—— 全项目的「词汇表」

- 看点：`Block` 三选一（`TextBlock | ToolUse | ToolResult`）与 `Message`
- 核心决策：内部消息格式为什么是 Anthropic 风格？——内容块模型表达力更强
  （文本与工具调用混排保序、参数是对象），翻译只发生在协议边界。详见附录 A
- `LlmResult`：两条协议调用完归一成同一形状，core 因此完全无感

### 第 2 站：`src/config/index.ts`（79 行）—— 三处全局状态之一

- 看点：`resolveProvider()` 的四级优先级合并（CLI > env > settings.json > PRESETS）。
  拿纸推演：`--provider anthropic -m k3` + env `ANTHROPIC_BASE_URL` 时每个字段来自哪一级
- 注意：`let provider` 是全局可变状态第①处，`get/setProvider` 是唯一读写口
- 思考题：`fail()` 直接 `process.exit(1)` 而不 throw——为什么配置错误适合这么粗暴？

### 第 3 站：`src/tools/`（6 文件）—— 最简单的适配层，热身用

- 读法：`truncate.ts` → `read.ts` → `edit.ts` → `bash.ts` → `index.ts`
- 看点：
  - `truncate.ts`：行数+字节双段截断——行数防大文件刷屏，字节数防单行巨大的 minified 文件
  - `edit.ts`：**全量预校验再应用**（所有 oldText 先在原文件上校验存在性+唯一性，
    全部通过才动手）——pi 防「改一半留半成品」的策略，重点理解
  - `bash.ts`：返回 Promise 但**不 reject**——错误也走正常返回字符串。
    为什么？（失败要回灌给模型自我纠正，不是程序错误；见第 5 站）
  - `index.ts`：TOOLS schema 是协议无关的中间格式；description 是写给**模型**的提示词
- 思考题：`resolvePath` 为什么在三个文件里重复定义而不抽公共模块？值不值？

### 第 4 站：`src/llm/`（4 文件）—— 技术含量最高的部分

- 读法：`sse.ts` → `anthropic.ts` → `openai.ts` → `index.ts`
- 看点：
  - `sse.ts`：只有 20 行但是流式根基。理解 `sse = events.pop()!`——
    **TCP 包边界不对齐事件边界**，不完整的帧留到下次拼。流式解析最易错的点
  - `anthropic.ts`：事件类型驱动的状态机。重点是 `content_block_delta` 的两种增量
    （文本直接回调打印 vs 工具参数累积 JSON 分片）与 `filter(Boolean)` 兜底
  - `openai.ts`：三段式（1 消息转换 → 2 流式累积 → 3 组装回 Block[]）。
    **与 anthropic.ts 对比着读**：本质同一件事（增量 → 完整 Block[]），事件形状不同——
    这就是「适配层」：把两种外部方言翻译成同一种内部语言
  - `index.ts`：19 行纯分发，体会「core 只面对 `callLLM` 一个函数」
- 思考题：`finish_reason: "length"` 为什么映射成 `"max_tokens"`？
  （让第 5 站的截断保护对两条协议都生效，映射发生在适配层，core 不用写两套判断）

### 第 5 站：`src/core/`（2 文件）—— 业务编排

- `prompt.ts`（35 行）：快速过，注意 `AGENTS.md`/`CLAUDE.md` 的 xml 标签注入方式
- `agent.ts`（73 行）：**全项目的心脏**，逐行精读
  - 循环骨架：`for(;;)` + 三个出口（MAX_TURNS 保险丝 / 无工具调用 break / 异常上抛）
  - **max_tokens 保护**：截断时不执行任何工具、错误回灌——第 4 站的映射在此闭环
  - **失败回灌**：工具抛异常 → catch → `is_error:true` 照样入历史。
    loop 永不因工具失败崩溃，模型拿到错误自我纠正——agent 鲁棒性的核心设计
  - `AgentUI` 接口：数一下有几处 `ui.` 调用（5 处），各对应终端上的一类输出
- 思考题：`messages.push` 在循环里发生几次？分别推入什么角色？
  （画出来——这是 session 持久化 D2 的预习）

### 第 6 站：`src/cli/`（2 文件）

- `render.ts`：`paint` 的 TTY 退化（非 TTY 输出无色，否则管道到文件会带 ANSI 控制符）；
  `summarize` 是写给扫读终端的人看的；`createTerminalUI()` 就是注入 core 的实现
- `repl.ts`：重点是 **for-await 迭代 readline** 的头部注释——真实踩过的管道 bug，
  `closed` 标志守护 `rl.prompt()` 的来龙去脉值得看懂；
  `/model` 分支里 `getProvider/setProvider` 与第 2 站闭环

### 第 7 站：`src/main.ts`（79 行）—— 组合根，第一遍终点

- 三块结构：参数解析 → 装配（`setProvider` + 构建 `ctx`）→ 分发（单发 vs REPL）
- 体会：main 是唯一 import 所有层的文件，「装配」就是把各层零件在这里接上线

## 第二遍：数据流追踪（外 → 内，30 分钟）

拿真实案例追一遍：`node src/main.ts --provider anthropic -p "用 read 工具读 package.json..."`

```
main.ts     参数解析 → setProvider → buildSystemPrompt → 进单发分支
  ↓ messages = [{role:"user", content:"用 read 工具读..."}]
agent.ts    第 1 次循环：callLLM(getProvider(), ...)
  ↓
llm/index.ts    protocol==="anthropic" → callAnthropic
llm/anthropic.ts 拼请求体(system/messages/tools) → fetch → sseJson 逐帧
  ↓ 模型流式返回：先文字后 tool_use
sse.ts      TCP 分片 → 完整事件 JSON
  ↓ onText 实时打到终端（ui.text → render.ts）
agent.ts    收到完整 LlmResult → push assistant 消息 → 发现 tool_use
  ↓ ui.toolCall() 打印 "→ read package.json"
tools/index.ts  runTool("read", {path}) → read.ts
  ↓ 读文件、加行号、truncate
agent.ts    ui.result() 预览前 5 行 → push tool_result(role:"user") → 第 2 次循环
  ↓ 这次模型回纯文本，无 tool_use → break
main.ts     console.log() 换行，进程结束
```

追踪时在纸上画出 `messages` 数组在每个时刻的内容（3 条消息的形态变化）。

## 毕业自测题（答得出 = 理解到位）

1. 为什么 tool_result 要以 `role:"user"` 回灌？OpenAI 路径在哪一步、怎么变成 `role:"tool"`？
2. 新增一个协议（比如 Gemini）要动哪几个文件？哪些文件**保证不用动**？
3. `/model anthropic` 切换后，下一轮 agentTurn 怎么用到新 provider？（追 `getProvider` 调用时机）
4. 为什么 `AgentUI` 要注入，而不是 core 直接 `console.log`？（至少两个收益）
5. bash 命令失败（exit code 1）和 fetch 网络失败，分别走哪条路径？为什么不同？
6. 模型返回的 tool_use 参数 JSON 损坏，有几道防线？分别在哪？
7. 全局可变状态有三处，目前实现了几处、在哪？（另外两处是 D2/D4 的内容）

## 附录 A：为什么内部消息格式是「Anthropic 风格」

指 `src/types.ts` 的内存数据结构照搬 Anthropic Messages API 的消息模型：

```jsonc
// 内部格式 ≈ Anthropic 形状：content 是块数组，文本与工具调用混排保序
{ role: "assistant", content: [
  { type: "text", text: "我看一下" },
  { type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } } ]}  // input 是对象
{ role: "user", content: [
  { type: "tool_result", tool_use_id: "t1", content: "...", is_error: false } ]}

// 对照 OpenAI 形状：文本与调用拆成两个字段；参数是字符串；结果是独立的 role:"tool" 消息
{ role: "assistant", content: "我看一下",
  tool_calls: [{ id: "t1", type: "function",
                 function: { name: "read", arguments: "{\"path\":\"a.ts\"}" } }] }
{ role: "tool", tool_call_id: "t1", content: "..." }
```

**为什么内部流转也需要格式**：agent 的消息不是字符串，是结构化数据（调用有 id/名字/参数，
结果按 id 关联、带错误标记）。loop 每轮都要读写这个结构，「无风格」不存在——
总要选一种内存表示。真正的选择是：

| 方案 | 后果 |
|---|---|
| 自己发明中立格式 | 写两套双向翻译器，工作量翻倍，零收益 |
| 用 OpenAI 格式当内部格式 | arguments 是字符串，core 反复 parse/stringify；不保序；低表达力向上映射丢信息 |
| **Anthropic 格式当内部格式**（本项目） | anthropic 路径零转换直通；openai 路径只在边界翻译一次；高表达力向下映射无损 |

一句话：**内部格式选表达力更强的那个，让翻译只发生在不得不发生的地方（协议边界）**——
经典防腐层思路，`core/agent.ts` 里一个协议相关的 if 都没有。
注意：选 Anthropic 风格 ≠ 偏向 Anthropic；默认 provider 是 DeepSeek（OpenAI 协议），不受影响。

**参考对象**：pi 就是这样（pi-mono `packages/ai` 的内部类型以 Anthropic content block 为蓝本，
每个 provider 一个 transform 在边界翻译——本项目的 `types.ts`+`llm/` 是其极简版）。
dsh 的消息层实现未确认（公开信息以 OpenAI 兼容协议为中心），待读源码验证。
