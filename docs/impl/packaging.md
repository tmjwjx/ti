# 打包余项 —— 开发大纲

> 对应包号 0.0.8 · 本文是这一版的开发依据
> 功能背景与验收见 `docs/PRD.md`「npm 打包就绪」；打包现状见 `docs/DESIGN.md` §4

## 0. 现状与已定的取舍

已经达标，这一版不动：

| 项 | 现在 | 要求 |
|---|---|---|
| 发布产物 | `bin/ti.js` 单文件 68KB（esbuild minify，无 sourcemap） | — |
| 包内文件 | `package.json`、`README.md`、`LICENSE`、`bin/ti.js` 共 4 个 | 只含白名单 |
| 包体 | 压缩 26KB，解压 71KB | < 100KB |
| 冷启动 | `ti --help` 60–70ms | < 300ms |

这一版要做的：

| 项 | 定了什么 |
|---|---|
| README | `README.md` 英文，npm 页面显示这份；`docs/README.zh.md` 中文，内容一致，两份互相链接。只写安装和用法。中文版不进 npm 包 |
| `ti --version` | 加 `-v` / `--version`。版本号构建时写进 `bin/ti.js`，开发时从 `package.json` 读 |
| `package.json` 元信息 | 补 `repository`、`homepage`、`bugs`、`keywords`、`author` |
| 打包检查脚本 | `scripts/pack-check.mjs`：构建、打包、装到临时目录、跑 `ti --version` 与 `ti --help`，检查文件白名单和体积 |
| CI | 不做。一个人开发、提交前本地都跑过 `npm test`，CI 重复这些事。Node 22 发版前用 `npx -p node@22 npm test` 手动测一次 |
| 类型检查 | 加 devDependency `typescript` 和脚本 `npm run check`。只在开发时用，不进包，零运行时依赖不变 |
| 不做 | `npm publish`、仓库转公开、README 截图或 GIF |

## 1. README

只写怎么装、怎么用，保持短。两份内容一致，只是语言不同。

**内容**：

1. 一句话介绍
2. 安装：`npm i -g @tmjwjx/ti`，Node ≥ 22.18
3. 首次运行：进项目目录运行 `ti`，第一次会弹出配置向导，`ti setup` 可以重新配置
4. 命令行参数：`--provider`、`-m`、`--resume`、`--version`
5. 斜杠命令
6. 快捷键
7. 会话、压缩、skills：各一两句

**不写**：安全说明、内置厂家列表与自定义厂家示例、PATH 冲突排查、配置字段说明。

**互相链接**：两份开头都放一行语言切换。中文版不进 npm 包，所以英文版里指向中文版的链接用 GitHub 地址。仓库现在还是私有的，转公开之前这个链接打不开，这是已知情况。

**写法**：只写现在已经有的功能，不写计划。示例命令都要实际跑过一遍。

## 2. `ti --version`

- `main.ts` 的参数解析里加 `-v` / `--version`：打印版本号（只有号本身，比如 `0.0.8`），退出码 0。`help()` 的用法里加上这一行。
- 版本号来源，新文件 `src/version.ts`：
  - 发布产物：`scripts/build.mjs` 用 esbuild 的 `define`，把 `package.json` 里的版本号写成常量。
  - 开发时直接跑 `src/`：用 `import.meta.url` 找到上级目录的 `package.json`，读出版本号。
  - 不用 `import … with { type: "json" }`：部分 Node 22 版本会在每次启动时打印实验特性警告。

## 3. `package.json`

```jsonc
{
  "repository": { "type": "git", "url": "git+https://github.com/tmjwjx/ti.git" },
  "homepage": "https://github.com/tmjwjx/ti#readme",
  "bugs": { "url": "https://github.com/tmjwjx/ti/issues" },
  "keywords": ["coding-agent", "cli", "terminal", "llm", "ai", "anthropic", "openai", "deepseek", "kimi", "glm"],
  "author": "tmjwjx",
  "scripts": {
    "check": "tsc --noEmit -p .",
    "pack:check": "node scripts/pack-check.mjs"
  },
  "devDependencies": { "typescript": "^5" }
}
```

`files` 保持 `["bin"]`。npm 会强制打包根目录下所有 `README*`，`files` 里写 `!README.zh.md` 也排除不掉，所以中文版放在 `docs/README.zh.md`。

## 4. 打包检查脚本 `scripts/pack-check.mjs`

零依赖，只用 Node 标准库和 `npm` 命令。按顺序做下面几步，任一步失败就打印原因，以非零退出码结束：

1. `npm run build`
2. `npm pack --json --pack-destination <临时目录>`，从输出里拿到文件列表和解包大小
3. 文件列表必须正好是 `package.json`、`README.md`、`LICENSE`、`bin/ti.js`，多一个少一个都算失败
4. 解包大小必须小于 100KB
5. `npm i -g <tgz> --prefix <临时目录>`，装到临时目录，不碰本机的全局目录
6. 运行装好的 `ti --version`，输出必须等于 `package.json` 里的版本号
7. 运行装好的 `ti --help`，退出码为 0，输出里有 `usage: ti`
8. 删掉临时目录

`--version` 和 `--help` 都不读配置、不发请求，所以不需要 API key。为了保险，运行时把 `HOME` 也指向临时目录。

## 5. 落点

| 文件 | 改什么 |
|---|---|
| `README.md` | 按 §1 改成英文，只写安装和用法 |
| `docs/README.zh.md`（新） | 中文版，内容与英文版一致 |
| `src/version.ts`（新） | 版本号 |
| `src/main.ts` | `-v` / `--version`；`help()` 加一行 |
| `scripts/build.mjs` | `define` 写入版本号 |
| `scripts/pack-check.mjs`（新） | §4 |
| `package.json` / `package-lock.json` | §3；包号 `0.0.8`（CR 之后） |
| `test/` | `--version` 在开发模式下读得到正确的版本号 |
| 文档 | `PRD.md` 打包那一行改成已落地；`DESIGN.md` §4；`ARCHITECTURE.md` 源码树；`VERSIONS.md`；`READING.md` |

## 6. 已知风险

- **Node 22.18 没有实测**：本机是 Node 26。发版前用 `npx -p node@22 npm test` 手动测一次。
- **中文 README 链接打不开**：仓库转公开之前，npm 页面上指向 GitHub 的链接无效。
- **`npm i -g --prefix` 在 Windows 上的目录结构不同**：命令不在 `<prefix>/bin` 下，`pack-check` 要按平台找路径。Windows 不实测。

## 7. 不做

`npm publish`、git tag、仓库转公开、README 截图或 GIF、GitHub Actions CI、代码覆盖率、lint 或格式化工具。
