# 相对 0.0.5 的变更阅读指南

对照点：`package.json` 0.0.5 → 0.0.6。
0.0.5 里已经懂的（`toLlm`、`summary`、`aborted`、↑ 回灌）**跳过**。这里只标 skills，以及两处顺带的改动。

本地：`npm start`。别用全局 `ti`。

---

## 建议顺序

```
1. docs/impl/skills.md      这一版怎么做
2. src/core/skills.ts       新 · 整篇：扫描、frontmatter、清单、读全文
3. src/core/prompt.ts       buildSystemPrompt(skills) 末尾追加清单
4. src/types.ts             SkillMessage
5. src/llm/index.ts         toLlm 里的 skillToUser
6. src/cli/repl.ts          skillOf、/skills、chat() 抽出来共用、撤回改比对象、busy 判断
7. src/cli/tui.ts           回车带参数时提交整行
8. src/core/session.ts      asMessage 认 skill、inputText 统一起名；删掉 ensureGitignore、版本升级
9. src/core/compact.ts      estimateTokens、serialize 认 skill
10. src/cli/render.ts       重放 skill
11. src/main.ts             loadSkills(commandNames())
```

---

## 一条路径

```
启动
  loadSkills 扫 .ti/skills、~/.ti/skills → 清单进系统提示词

模型自己用
  清单里描述对得上 → read 那份 SKILL.md → 照做

用户 /demo add orders
  内置命令都没接住 → skillOf 找到 demo → readSkillBody
  → chat() 存成 skill 角色 → toLlm 翻成 <skill …>全文</skill> + 参数
```

---

## 顺带的三处

- 建会话时不再往用户项目的 `.gitignore` 里加 `.ti/`。
- 不做旧格式兼容：会话封面版本号回到 1，0.0.5 加的「接上旧文件时改写版本号」删掉。还没有正式版，没有存量文件。
- TUI 输入 `/rename foo` 回车，以前只提交 `/rename`，参数丢了。现在带参数就提交整行。
