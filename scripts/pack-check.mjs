// 发布前检查：构建、打包、装到临时目录跑一下，确认包里只有该有的文件、体积不超、命令能用
// 不碰本机全局目录，不读真实的 ~/.ti
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXPECTED = ["LICENSE", "README.md", "bin/ti.js", "package.json"];
const MAX_UNPACKED = 100 * 1024;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// 跑一条命令，返回 stdout。失败时把命令和输出一起抛出
function run(cmd, args, env) {
  return execFileSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}

// 打印失败原因并以非零退出
function fail(msg) {
  console.error(`pack-check: ${msg}`);
  process.exitCode = 1;
}

const root = mkdtempSync(join(tmpdir(), "ti-pack-"));
try {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  run(npm, ["run", "build"]);
  const [info] = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", root]));
  const files = info.files.map((f) => f.path).sort();
  if (JSON.stringify(files) !== JSON.stringify(EXPECTED)) {
    fail(`files are ${files.join(", ")}, expected ${EXPECTED.join(", ")}`);
  }
  if (info.unpackedSize >= MAX_UNPACKED) {
    fail(`unpacked size ${info.unpackedSize} bytes, limit ${MAX_UNPACKED}`);
  }

  // 装到临时前缀，HOME 也指过去，避免碰本机配置
  const prefix = join(root, "prefix");
  const env = { HOME: join(root, "home"), npm_config_prefix: prefix };
  run(npm, ["install", "-g", join(root, info.filename), "--prefix", prefix, "--no-audit", "--no-fund"], env);
  const bin = process.platform === "win32" ? join(prefix, "ti.cmd") : join(prefix, "bin", "ti");

  const printed = run(bin, ["--version"], env).trim();
  if (printed !== version) fail(`ti --version printed "${printed}", expected "${version}"`);
  const help = run(bin, ["--help"], env);
  if (!help.includes("usage: ti")) fail("ti --help did not print usage");

  if (!process.exitCode) {
    console.log(`pack-check ok · ${info.filename} · ${files.length} files · ${(info.unpackedSize / 1024).toFixed(1)}KB unpacked · ti ${printed}`);
  }
} catch (e) {
  fail(e instanceof Error ? `${e.message}\n${e.stdout ?? ""}${e.stderr ?? ""}` : String(e));
} finally {
  rmSync(root, { recursive: true, force: true });
}
