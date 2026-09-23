// ti update：把已安装的全局命令更新到官方源上查到的那个版本
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isBundled, VERSION } from "../version.ts";

const REGISTRY = "https://registry.npmjs.org";
const SPEC_NAME = "@tmjwjx/ti";

export type UpdatePlan = "dev" | "current" | "upgrade";
export type Installer = "npm" | "pnpm" | "yarn" | "bun";

export type InstallDecision =
  | { ok: true; command: string; args: string[] }
  | { ok: false; manual?: string };

// 比较两个版本号，左边更新返回 1，相同返回 0，右边更新返回 -1
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number(n) || 0);
  const pb = b.split(".").map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// 判断这次更新该拒绝、该停，还是该装
export function updatePlan(bundled: boolean, current: string, latest: string): UpdatePlan {
  if (!bundled) return "dev";
  return compareVersions(latest, current) > 0 ? "upgrade" : "current";
}

// 从安装路径判断用的是哪种安装器
export function detectInstaller(packagePath: string): Installer | undefined {
  const versions = process.versions as { bun?: string };
  if (versions.bun) return "bun";
  const p = packagePath.replaceAll("\\", "/").toLowerCase();
  if (p.includes("/.pnpm/") || p.includes("/pnpm/")) return "pnpm";
  if (p.includes("/.yarn/") || p.includes("/yarn/")) return "yarn";
  if (p.includes("/install/global/node_modules/")) return "bun";
  if (p.includes("/node_modules/")) return "npm";
  return undefined;
}

// 从 lib/node_modules 这种路径取出 npm 全局前缀。Windows 不推断
export function inferNpmPrefix(packageDir: string): string | undefined {
  if (process.platform === "win32") return undefined;
  const parts = resolve(packageDir).split(sep);
  const at = parts.lastIndexOf("node_modules");
  if (at < 2 || parts[at - 1] !== "lib") return undefined;
  return parts.slice(0, at - 1).join(sep) || sep;
}

// 拼出安装指定版本的命令，源写死为官方源
export function installCommand(installer: Installer, version: string, prefix?: string): { command: string; args: string[] } {
  const spec = `${SPEC_NAME}@${version}`;
  const registry = ["--registry", REGISTRY];
  const win = process.platform === "win32";
  switch (installer) {
    case "npm":
      return {
        command: win ? "npm.cmd" : "npm",
        args: [...(prefix ? ["--prefix", prefix] : []), "install", "-g", "--ignore-scripts", "--min-release-age=0", ...registry, spec],
      };
    case "pnpm":
      return {
        command: win ? "pnpm.cmd" : "pnpm",
        args: ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", ...registry, spec],
      };
    case "yarn":
      return {
        command: win ? "yarn.cmd" : "yarn",
        args: ["global", "add", "--ignore-scripts", ...registry, spec],
      };
    case "bun":
      return {
        command: "bun",
        args: ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", ...registry, spec],
      };
  }
}

// 安装目录是不是落在给出的全局根下面
export function isInsideGlobalRoot(packageDir: string, roots: string[]): boolean {
  const dir = resolve(packageDir);
  return roots.some((root) => {
    const rel = relative(resolve(root), dir);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
  });
}

// 决定能不能自己装。不能装但认得出安装器时，给出手敲的命令
export function decideInstall(packageDir: string | undefined, roots: string[], writable: boolean, version: string): InstallDecision {
  if (!packageDir) return { ok: false };
  const installer = detectInstaller(packageDir);
  if (!installer) return { ok: false };
  const prefix = installer === "npm" ? inferNpmPrefix(packageDir) : undefined;
  const built = installCommand(installer, version, prefix);
  const manual = [built.command, ...built.args].join(" ");
  if (!writable || !isInsideGlobalRoot(packageDir, roots)) return { ok: false, manual };
  return { ok: true, command: built.command, args: built.args };
}

// 向官方源查询已发布的最新包号
async function fetchLatest(): Promise<string> {
  const res = await fetch(`${REGISTRY}/@tmjwjx%2fti/latest`);
  if (!res.ok) throw new Error(`could not read the latest version (${res.status})`);
  const body = (await res.json()) as { version?: unknown };
  if (typeof body.version !== "string") throw new Error("could not read the latest version");
  return body.version;
}

// 从正在运行的文件往上找到所在的包目录
function packageDirOf(entry: string): string | undefined {
  let dir = dirname(resolve(entry));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return undefined;
}

// 安装目录和它的上一级是否可写
function writableInstall(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    accessSync(dirname(dir), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// 读一条命令的标准输出。失败当作没有
function readOutput(command: string, args: string[]): string | undefined {
  const r = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  if (r.status !== 0) return undefined;
  const text = r.stdout.trim();
  return text || undefined;
}

// 问安装器它的全局包目录在哪
function globalRoots(installer: Installer, prefix?: string): string[] {
  const win = process.platform === "win32";
  switch (installer) {
    case "npm": {
      const command = win ? "npm.cmd" : "npm";
      const args = ["root", "-g", ...(prefix ? ["--prefix", prefix] : [])];
      const root = readOutput(command, args);
      const inferred = prefix ? join(prefix, "lib", "node_modules") : undefined;
      return [root, inferred].filter((x): x is string => !!x);
    }
    case "pnpm": {
      const root = readOutput(win ? "pnpm.cmd" : "pnpm", ["root", "-g"]);
      return root ? [root, dirname(root)] : [];
    }
    case "yarn": {
      const dir = readOutput(win ? "yarn.cmd" : "yarn", ["global", "dir"]);
      return dir ? [dir, join(dir, "node_modules")] : [];
    }
    case "bun": {
      const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
      const bin = readOutput("bun", ["pm", "bin", "-g"]);
      if (bin) roots.push(join(dirname(bin), "install", "global", "node_modules"));
      return roots;
    }
  }
}

// 执行安装。找不到安装器时把命令印出来
function runInstall(command: string, args: string[]): number {
  const manual = [command, ...args].join(" ");
  const r = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.error) {
    console.error(`error: ${command} not found`);
    console.error(manual);
    return 1;
  }
  return r.status ?? 1;
}

// 执行 ti update：源码直跑则拒绝，已是最新则退出，否则安装
export async function runUpdate(): Promise<never> {
  if (!isBundled) {
    console.error("error: ti update only updates the installed command");
    process.exit(1);
  }
  let latest: string;
  try {
    latest = await fetchLatest();
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (updatePlan(true, VERSION, latest) === "current") {
    console.log(`${VERSION} is up to date`);
    process.exit(0);
  }
  const dir = process.argv[1] ? packageDirOf(process.argv[1]) : undefined;
  const installer = dir ? detectInstaller(dir) : undefined;
  const prefix = installer === "npm" && dir ? inferNpmPrefix(dir) : undefined;
  const decision = decideInstall(dir, dir && installer ? globalRoots(installer, prefix) : [], dir ? writableInstall(dir) : false, latest);
  if (!decision.ok) {
    console.error("error: ti cannot update this installation");
    if (decision.manual) console.error(decision.manual);
    process.exit(1);
  }
  console.log(`updating ${VERSION} → ${latest}`);
  process.exit(runInstall(decision.command, decision.args));
}
