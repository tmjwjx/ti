// ti update：版本比较、认安装器、能不能自己装
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, decideInstall, detectInstaller, inferNpmPrefix, updatePlan } from "../src/cli/update.ts";

const NPM_DIR = "/opt/homebrew/lib/node_modules/@tmjwjx/ti";

test("版本号按数字比，不是按字符串", () => {
  assert.equal(compareVersions("0.0.8", "0.0.8"), 0);
  assert.equal(compareVersions("0.0.10", "0.0.9"), 1);
  assert.equal(compareVersions("0.0.9", "0.0.10"), -1);
  assert.equal(compareVersions("0.1.0", "0.0.9"), 1);
});

test("源码直跑拒绝，已是最新则停，官方源更新才装", () => {
  assert.equal(updatePlan(false, "0.0.8", "0.0.9"), "dev");
  assert.equal(updatePlan(true, "0.0.8", "0.0.8"), "current");
  assert.equal(updatePlan(true, "0.0.9", "0.0.8"), "current");
  assert.equal(updatePlan(true, "0.0.8", "0.0.9"), "upgrade");
});

test("从路径认出安装器", () => {
  assert.equal(detectInstaller(NPM_DIR), "npm");
  assert.equal(detectInstaller("/Users/me/Library/pnpm/global/5/node_modules/@tmjwjx/ti"), "pnpm");
  assert.equal(detectInstaller("/Users/me/.config/yarn/global/node_modules/@tmjwjx/ti"), "yarn");
  assert.equal(detectInstaller("/Users/me/.bun/install/global/node_modules/@tmjwjx/ti"), "bun");
  assert.equal(detectInstaller("/tmp/ti"), undefined);
});

test("能自己装时命令里是查到的版本和官方源", () => {
  const d = decideInstall(NPM_DIR, ["/opt/homebrew/lib/node_modules"], true, "0.0.9");
  assert.equal(d.ok, true);
  if (!d.ok) return;
  assert.ok(d.args.includes("@tmjwjx/ti@0.0.9"));
  assert.ok(d.args.includes("--ignore-scripts"));
  assert.ok(d.args.includes("https://registry.npmjs.org"));
  if (process.platform !== "win32") {
    assert.equal(inferNpmPrefix(NPM_DIR), "/opt/homebrew");
    assert.deepEqual(d.args.slice(0, 2), ["--prefix", "/opt/homebrew"]);
  }
});

test("不在全局目录或不可写时不装，但给出手敲的命令", () => {
  const outside = decideInstall(NPM_DIR, ["/usr/local/lib/node_modules"], true, "0.0.9");
  assert.equal(outside.ok, false);
  if (outside.ok) return;
  assert.match(outside.manual ?? "", /@tmjwjx\/ti@0\.0\.9/);

  const locked = decideInstall(NPM_DIR, ["/opt/homebrew/lib/node_modules"], false, "0.0.9");
  assert.equal(locked.ok, false);
});

test("认不出安装器时不给命令", () => {
  const d = decideInstall("/tmp/ti", [], true, "0.0.9");
  assert.deepEqual(d, { ok: false });
});

test("pnpm、yarn、bun 各自的安装命令", () => {
  const pnpm = decideInstall("/Users/me/Library/pnpm/global/5/node_modules/@tmjwjx/ti", ["/Users/me/Library/pnpm/global/5/node_modules"], true, "0.0.9");
  const yarn = decideInstall("/Users/me/.config/yarn/global/node_modules/@tmjwjx/ti", ["/Users/me/.config/yarn/global/node_modules"], true, "0.0.9");
  const bun = decideInstall("/Users/me/.bun/install/global/node_modules/@tmjwjx/ti", ["/Users/me/.bun/install/global/node_modules"], true, "0.0.9");
  assert.equal(pnpm.ok && pnpm.command.startsWith("pnpm"), true);
  assert.equal(yarn.ok && yarn.args[0] === "global", true);
  assert.equal(bun.ok && bun.command === "bun", true);
});
