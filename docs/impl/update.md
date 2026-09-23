# ti update —— 开发大纲

> 对应包号 0.0.9 · 本文是这一版的开发依据

## 0. 做什么

`ti update` 把已经装到全局的 `ti` 更新到官方源上的确切版本。不读配置，不进对话。

最新号问 `https://registry.npmjs.org`，不走本机默认源。装的时候也写死这个源。安装命令照 pi 的自更新：认出是 npm、pnpm、yarn 还是 bun，装查到的那个版本号，并带上 `--ignore-scripts`。

## 1. 行为

1. 参数只有 `update`。多了别的参数，打印用法，退出码 1。
2. `npm start` 或 `node src/main.ts`：没有构建注入的包号。打印 `error: ti update only updates the installed command`，退出码 1。不访问网络，不调用安装器。
3. 已安装的命令：请求 `https://registry.npmjs.org/@tmjwjx/ti/latest`。
   - 失败：打印原因，退出码 1，不安装。
   - 官方源不比本地新：打印 `<当前版本> is up to date`，退出码 0。本地更新也不降级。
4. 官方源更新时，先看这次安装能不能自己改：
   - 用正在运行的文件的真实路径判断安装器。路径里有 `.pnpm` 或 `/pnpm/` 是 pnpm，有 `.yarn` 或 `/yarn/` 是 yarn，是 bun 运行时或 bun 的全局目录是 bun，其余落在 `node_modules` 里是 npm。对不上就是 unknown。
   - 安装目录必须落在该安装器的全局根下面：`npm root -g`、`pnpm root -g`、`yarn global dir`、bun 的全局 `node_modules`。npm 若能从路径看出 `<prefix>/lib/node_modules/@tmjwjx/ti`，全局根用这个 prefix（Windows 不推断 prefix）。
   - 安装目录和它的上一级都要可写。
   - 任一不满足：打印 `error: ti cannot update this installation`，下一行打出应当手敲的安装命令，退出码 1。不真正执行。
5. 能改：打印 `updating <当前> → <最新>`，再执行下面之一。输出原样给用户，退出码跟安装器。安装器不在 PATH 上：打印 `error: <命令> not found` 和同一条命令，退出码 1。

装的是 `@tmjwjx/ti@<刚查到的版本>`，不是 `@latest`。都写死 `--registry https://registry.npmjs.org`。

| 安装器 | 命令 |
|---|---|
| npm | `npm [--prefix <prefix>] install -g --ignore-scripts --min-release-age=0 --registry https://registry.npmjs.org @tmjwjx/ti@<版本>` |
| pnpm | `pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 --registry https://registry.npmjs.org @tmjwjx/ti@<版本>` |
| yarn | `yarn global add --ignore-scripts --registry https://registry.npmjs.org @tmjwjx/ti@<版本>` |
| bun | `bun install -g --ignore-scripts --minimum-release-age=0 --registry https://registry.npmjs.org @tmjwjx/ti@<版本>` |

Windows 上 npm、pnpm、yarn 的可执行文件名加 `.cmd`。

本机现在是 Homebrew 的 npm，路径是 `/opt/homebrew/lib/node_modules/@tmjwjx/ti`，会走 npm 并带 `--prefix /opt/homebrew`。

## 2. 落点

| 文件 | 改什么 |
|---|---|
| `src/cli/update.ts` | 换成上面的判断和安装命令 |
| `test/update.test.ts` | 版本比较、从路径认安装器、拼出的命令、不该装的情形。不访问网络，不真的安装 |
| `src/version.ts`、`src/main.ts`、两份 README | 已有行为不变 |

## 3. 不做

`--force`、设置里的自定义 npm 命令、Windows 上搬开正在占用的原生文件、换包名、扩展和模型目录、`pi.dev`、semver 依赖。不在对话里做 `/update`。不改 `~/.npmrc`。这一版不自己发 npm。
