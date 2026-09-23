# 相对 0.0.8 的变更阅读指南

对照点：`package.json` 0.0.8 → 0.0.9。
这一版只加 `ti update`。

本地：`npm test`、`npm run check`。源码直跑时 `node src/main.ts update` 会拒绝，这是对的。

---

## 建议顺序

```
1. docs/impl/update.md    这一版做什么
2. src/cli/update.ts      新：比较版本、查官方源、调用 npm
3. src/version.ts         isBundled：发布产物才允许更新
4. src/main.ts            参数 update；help 加一行
5. README.md、docs/README.zh.md
```
