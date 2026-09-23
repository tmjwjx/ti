# 相对 0.0.7 的变更阅读指南

对照点：`package.json` 0.0.7 → 0.0.8。
这一版只动打包相关，功能代码只加了 `--version`。

本地：`npm test`、`npm run check`、`npm run pack:check`。

---

## 建议顺序

```
1. docs/impl/packaging.md       这一版做什么、不做什么
2. src/version.ts               新：包号从哪来
3. src/main.ts                  -v / --version；help 第一行带包号
4. scripts/build.mjs            define 写入包号
5. scripts/pack-check.mjs       新：构建、打包、装到临时目录、查白名单与体积、跑 --version / --help
6. package.json                 元信息、check 与 pack:check、typescript 开发依赖
7. README.md、docs/README.zh.md 只写安装和用法
```

---

## 顺带发现的

npm 会强制把根目录下所有 `README*` 打进包，`files` 里写排除也没用。所以中文版放在 `docs/README.zh.md`，英文版里用 GitHub 地址指过去。仓库转公开之前这个链接打不开。
