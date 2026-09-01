# ti 代码阅读指南

一次读一个文件。只看已经存在的 [`src/`](../src/)，别先读 [DESIGN.md](./DESIGN.md)（里面有尚未实现的模块）。

依赖只能由外向内：[`cli/`](../src/cli/) → [`core/`](../src/core/) → [`llm/`](../src/llm/) [`tools/`](../src/tools/) [`config/`](../src/config/) → [`types.ts`](../src/types.ts)。每读一个文件，看它 `import` 了谁。

## 第一遍：从里往外

### 1. [src/types.ts](../src/types.ts)

三种消息：`user`（你打的字）、`assistant`（文本块 + 工具调用块，带 `usage` / `stopReason`）、`toolResult`（独立一条，用 `toolCallId` 对上调用）。

内部格式是自定义的，不绑任何一家 API。为什么，见 [附录 A](#附录-a内部消息格式)。

### 2. [src/tools/](../src/tools/)

顺序：[truncate.ts](../src/tools/truncate.ts) → [read.ts](../src/tools/read.ts) / [write.ts](../src/tools/write.ts) → [edit.ts](../src/tools/edit.ts) → [bash.ts](../src/tools/bash.ts) → [index.ts](../src/tools/index.ts)。

- [truncate.ts](../src/tools/truncate.ts)：行数 + 字节双段截断
- [edit.ts](../src/tools/edit.ts)：所有 `oldText` 先校验存在且唯一，全过才改
- [bash.ts](../src/tools/bash.ts)：失败也返回字符串，不 reject（要回灌给模型）
- [index.ts](../src/tools/index.ts)：`TOOLS` 是写给模型的说明书；`runTool` 按名分发

`resolvePath` 在三个文件里重复定义，值不值抽？

### 3. [src/config/index.ts](../src/config/index.ts)

`resolveProvider()`：CLI > `~/.ti/settings.json` > 预设（不采用环境变量的值）。推一遍 `--provider anthropic -m k3` 时每个字段从哪来。

`getProvider` / `setProvider` 是现在唯一的全局可变状态，[`/model`](../src/cli/repl.ts) 切的就是它。`fail()` 为什么直接 `process.exit(1)`？

### 4. [src/llm/](../src/llm/)

顺序：[sse.ts](../src/llm/sse.ts) → [index.ts](../src/llm/index.ts) → [anthropic.ts](../src/llm/anthropic.ts) 与 [openai.ts](../src/llm/openai.ts) 对照。

- [sse.ts](../src/llm/sse.ts)：TCP 包边界 ≠ 事件边界，不完整的帧留到下次拼
- [index.ts](../src/llm/index.ts)：只一个 `callLLM`，core 只认识它
- 两条协议都是「增量 → `AssistantMessage`」，差异关在这层

`stopReason` 归一成 `stop` / `length` / `toolUse`。

### 5. [src/core/](../src/core/)

[prompt.ts](../src/core/prompt.ts) 过一下。[agent.ts](../src/core/agent.ts) 逐行读：`callLLM` → 有 `toolCall` 就 `runTool` → `push` `toolResult` → 再调。出口：没工具 / `MAX_TURNS` / 请求抛错。

- `stopReason === "length"` 时不执行工具
- 工具失败照样 `push` `isError: true`，loop 不崩
- `ui.xxx` 只发语义事件，着色在 [render.ts](../src/cli/render.ts)

`messages.push` 几次、分别什么角色？画出来（D2 预习）。

### 6. [src/cli/](../src/cli/)

- [render.ts](../src/cli/render.ts)：`createTerminalUI()` 注入 core；非 TTY 无色
- [repl.ts](../src/cli/repl.ts)：`/model` 调 `setProvider`；`for-await` readline（见头部注释的管道 bug）

### 7. [src/main.ts](../src/main.ts)

解析参数 → `setProvider` + 拼 `ctx` → `-p` 单发，否则 REPL。唯一装配点。

[ARCHITECTURE.md](./ARCHITECTURE.md) 是 v0.1 归档；[PRD.md](./PRD.md) / [DESIGN.md](./DESIGN.md) 第一遍读完再看。

## 第二遍：跟一次请求

```bash
node src/main.ts --provider anthropic -p "用 read 工具读 package.json，只复述 name 和 version"
```

[main.ts](../src/main.ts) → [agent.ts](../src/core/agent.ts) → [llm/index.ts](../src/llm/index.ts) → [anthropic.ts](../src/llm/anthropic.ts) + [sse.ts](../src/llm/sse.ts) → [read.ts](../src/tools/read.ts) → 再回 [agent.ts](../src/core/agent.ts)。纸上画出 `messages` 每一步的形状。

## 过关题

1. 一次用户输入，`messages` 会 push 几次、什么角色？
2. `toolResult` 为什么平铺成独立消息？两条协议边界分别怎么处理？
3. 新增 Gemini 动哪些文件？哪些不用动？
4. `/model anthropic` 后，下一轮怎么用到新 provider？
5. 为什么注入 `AgentUI`，而不是 core 里 `console.log`？
6. bash 退出码 1 和 fetch 失败，为什么走不同路径？
7. 工具参数 JSON 损坏有几道防线？
8. 全局可变状态设计上三处，现在实现了几处？

## 附录 A：内部消息格式

2026-08-18 前内部借用 Anthropic 线格式。落盘（D2）前换成自定义格式（pi 同款），避免以后迁移 session。见 [types.ts](../src/types.ts)。

```jsonc
{ role: "assistant", content: [
  { type: "text", text: "我看一下" },
  { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } } ],
  stopReason: "toolUse", usage: { input: 123, output: 45 } }
{ role: "toolResult", toolCallId: "t1", toolName: "read", content: "...", isError: false }
```

块模型学 Anthropic（混排保序、参数是对象），`toolResult` 平铺学 OpenAI。

| 若用线格式当内部格式 | 问题 |
| --- | --- |
| OpenAI | arguments 是字符串；文本与工具调用顺序丢失 |
| Anthropic | 没地方挂 usage；换协议要迁 session |

边界翻译（core 无感）：

- [anthropic.ts](../src/llm/anthropic.ts)：toolCall→tool_use；连续 toolResult 归并进一条 user
- [openai.ts](../src/llm/openai.ts)：toolCall→tool_calls；toolResult 1:1 → `role:"tool"`
- 入站都归一成 `AssistantMessage`；`stopReason` → `stop` / `length` / `toolUse`
