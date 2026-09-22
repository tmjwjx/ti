# 相对 0.0.3 的变更阅读指南

对照点：`package.json` 0.0.3 → 0.0.4。
0.0.3 里已经懂的（会话文件、锁、恢复、改名）**跳过**。这里只标 `/compact` 这一刀。

本地：`npm start`。别用全局 `ti`。

---

## 建议顺序

```
1. docs/impl/compact.md   这一版怎么做、阈值、切点
2. core/compact.ts        新 · 整篇
3. cli/repl.ts            /compact、发请求前自动压、超限重试、/cost 结转
4. core/session.ts        只看 commitCompact
5. llm/index.ts           isContextOverflowError
6. llm/anthropic.ts       usage 加上缓存 token；空 tools 不发
7. llm/openai.ts          空 tools 不发
8. config/index.ts        模型窗口 contextWindow
```

`src/core/agent.ts` 没改。压缩发生在 `agentTurn` 外面。

---

## 一条路径

```
用量超过阈值，或用户敲 /compact
  runCompact → 摘要更早的历史，留下最近一段
  commitCompact：分隔、摘要、再把保留段追加到分隔之后
恢复
  loadMessages 只读最后一道分隔之后，所以是摘要加保留段
模型报上下文超限
  再压一次，然后重进这一轮，只重试一次
```
