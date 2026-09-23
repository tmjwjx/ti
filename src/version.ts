// 当前包号。发布产物里由构建写死，开发直跑 src 时从 package.json 读
import { readFileSync } from "node:fs";

declare const __TI_VERSION__: string | undefined;

// 读项目根目录的 package.json 里的 version。读不到就是 unknown
function devVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

// 发布产物里构建会写死包号，开发直跑 src 时没有这个注入
export const isBundled: boolean = typeof __TI_VERSION__ === "string";

export const VERSION: string = typeof __TI_VERSION__ === "string" ? __TI_VERSION__ : devVersion();
