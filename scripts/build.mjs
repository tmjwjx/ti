// 发布用构建：把 src 打成一份 bin/ti.js
//
// 这不是加密。esbuild minify 只做：并文件、缩短名字、去掉空白和注释
// sourcemap: false —— 不生成 .map，避免对照表把原文带出去（Claude Code 2.1.88 那种）
// 开发仍用 npm start（直接跑 src）。只有 pack 或 publish 才用这份
import { readFileSync } from "node:fs";
import * as esbuild from "esbuild";

// 包号写死进产物，发布后不再去读 package.json
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  sourcemap: false,
  outfile: "bin/ti.js",
  banner: { js: "#!/usr/bin/env node\n" },
  define: { __TI_VERSION__: JSON.stringify(version) },
});

console.error("wrote bin/ti.js (minified, no source map)");
