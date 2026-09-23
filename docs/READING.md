# 相对 0.0.4 的变更阅读指南

对照点：`package.json` 0.0.4 → 0.0.5。
0.0.4 里已经懂的（压缩阈值、切点、超限重试）**跳过**。这里只标输入体验，以及它牵动的摘要和中断。

本地：`npm start`。别用全局 `ti`。

---

## 建议顺序

```
1. docs/impl/history.md     这一版怎么做
2. src/types.ts             summary 角色、aborted、LlmMessage
3. src/llm/index.ts         toLlm：摘要翻译、跳过 aborted、合并相邻 user
4. src/core/agent.ts        finishInterrupted 两种收尾
5. src/core/compact.ts      pi 的提示词、previous-summary、文件清单
6. src/core/session.ts      格式 v2、asMessage、repairMessages、bindSession 升级
7. src/cli/render.ts        重放 summary 和 aborted
8. src/cli/tui.ts           remember、addHistory、\ 续行
9. src/cli/repl.ts          回灌、管道续行、/help 快捷键
```

`anthropic.ts`、`openai.ts` 只把入参改成 `LlmMessage[]`，函数体没动。`main.ts` 没改。

---

## 一条路径

```
恢复会话
  pickAndResume → replayMessages → addHistory(user 消息)
  ↑ 翻到的是这个会话里亲手打过的话

压缩
  旧摘要单独放进 <previous-summary>
  新摘要存成 summary 角色，files 是代码统计的读过、改过
  发请求时 toLlm 才加上英文前后缀和 <summary>

打断
  工具跑到一半：给没跑的工具补错误结果
  请求中被打断：存 stopReason aborted，下次发请求整条跳过
```
