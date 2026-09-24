// config/index.ts：settings.json 读写、厂家字段优先级、模型与厂家列表、上下文窗口
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolate } from "./helpers.ts";

const box = isolate();
const settingsFile = join(box.home, ".ti", "settings.json");
mkdirSync(join(box.home, ".ti"), { recursive: true });
writeFileSync(settingsFile, JSON.stringify({ provider: "deepseek", providers: { deepseek: { apiKey: "boot-key" } } }));

const config = await import("../src/config/index.ts");
const { CATALOG, getProvider, isProviderReady, listModels, listProviderNames, loadSettings, reloadSettings, resolveProvider, setProvider, writeProvider } = config;
const settingsAtImport = config.settings;

// 把一份 settings 写到临时 HOME 并重新读进来
function useSettings(value: unknown): void {
  mkdirSync(join(box.home, ".ti"), { recursive: true });
  writeFileSync(settingsFile, typeof value === "string" ? value : JSON.stringify(value));
  reloadSettings();
}

beforeEach(() => useSettings({}));

describe("settings 文件", () => {
  test("路径在 HOME 下，import 时就读进来", () => {
    assert.equal(config.SETTINGS_PATH, settingsFile);
    assert.deepEqual(settingsAtImport, { provider: "deepseek", providers: { deepseek: { apiKey: "boot-key" } } });
  });

  test("文件不存在当空配置", () => {
    rmSync(settingsFile);
    assert.deepEqual(loadSettings(), {});
    reloadSettings();
    assert.deepEqual(config.settings, {});
  });

  test("JSON 坏了时保存不覆盖原文件", () => {
    const raw = "{ not json\n";
    writeFileSync(settingsFile, raw);
    reloadSettings();
    writeProvider("glm", { apiKey: "should-not-land" });
    assert.equal(readFileSync(settingsFile, "utf8"), raw);
  });

  test("文件读不了时保存不覆盖原文件", { skip: process.getuid?.() === 0 }, () => {
    const raw = "{\"provider\":\"kimi\"}\n";
    writeFileSync(settingsFile, raw);
    chmodSync(settingsFile, 0);
    try {
      reloadSettings();
    } finally {
      chmodSync(settingsFile, 0o600);
    }
    writeProvider("glm", { apiKey: "should-not-land" });
    assert.equal(readFileSync(settingsFile, "utf8"), raw);
  });

  test("writeProvider 浅合并、设为当前并落盘，目录 0700 文件 0600", () => {
    rmSync(join(box.home, ".ti"), { recursive: true, force: true });
    reloadSettings();
    writeProvider("kimi", { apiKey: "k1", model: "kimi-k3" });
    writeProvider("kimi", { model: "other" });
    const saved = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.deepEqual(saved, { providers: { kimi: { apiKey: "k1", model: "other" } }, provider: "kimi" });
    assert.ok(readFileSync(settingsFile, "utf8").endsWith("}\n"));
    assert.equal(statSync(join(box.home, ".ti")).mode & 0o777, 0o700);
    assert.equal(statSync(settingsFile).mode & 0o777, 0o600);
  });

  test("已有宽权限的文件与目录保存时收紧", () => {
    chmodSync(settingsFile, 0o644);
    chmodSync(join(box.home, ".ti"), 0o755);
    writeProvider("glm", { apiKey: "g" });
    assert.equal(statSync(settingsFile).mode & 0o777, 0o600);
    assert.equal(statSync(join(box.home, ".ti")).mode & 0o777, 0o700);
  });
});

describe("resolveProvider 字段优先级", () => {
  test("目录项只写 key：协议、地址、鉴权、默认模型、窗口都来自 CATALOG", () => {
    useSettings({ providers: { deepseek: { apiKey: "sk" } } });
    assert.deepEqual(resolveProvider("deepseek"), {
      name: "deepseek",
      protocol: "openai",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      apiKey: "sk",
      auth: "bearer",
      contextWindow: 1_000_000,
    });
  });

  test("kimi 目录项走 anthropic + bearer", () => {
    useSettings({ providers: { kimi: { apiKey: "kk" } } });
    const p = resolveProvider("kimi");
    assert.equal(p.protocol, "anthropic");
    assert.equal(p.auth, "bearer");
    assert.equal(p.baseURL, CATALOG.kimi!.baseURL);
  });

  test("settings 写了的字段盖过目录", () => {
    useSettings({
      providers: {
        deepseek: { apiKey: "sk", model: "deepseek-v4-pro", baseURL: "https://proxy.example/v1///", auth: "x-api-key" },
      },
    });
    const p = resolveProvider("deepseek");
    assert.equal(p.model, "deepseek-v4-pro");
    assert.equal(p.baseURL, "https://proxy.example/v1");
    assert.equal(p.auth, "x-api-key");
    assert.equal(p.contextWindow, 1_000_000);
  });

  test("CLI 模型参数盖过 settings；目录与 settings 都不认识的模型没有窗口", () => {
    useSettings({ providers: { deepseek: { apiKey: "sk", model: "deepseek-v4-pro" } } });
    const p = resolveProvider("deepseek", "brand-new-model");
    assert.equal(p.model, "brand-new-model");
    assert.equal(p.contextWindow, undefined);
  });

  test("settings 的 models 清单替代目录清单，首项作默认，窗口优先取 settings", () => {
    useSettings({
      providers: {
        deepseek: { apiKey: "sk", models: [{ id: "deepseek-v4-pro", contextWindow: 64_000 }, { id: "x" }] },
      },
    });
    const p = resolveProvider("deepseek");
    assert.equal(p.model, "deepseek-v4-pro");
    assert.equal(p.contextWindow, 64_000);
    assert.equal(resolveProvider("deepseek", "x").contextWindow, undefined);
    // settings 里这项没写窗口时退回目录
    useSettings({ providers: { deepseek: { apiKey: "sk", models: [{ id: "deepseek-v4-flash" }] } } });
    assert.equal(resolveProvider("deepseek").contextWindow, 1_000_000);
  });

  test("目录里没写窗口的模型就没有窗口", () => {
    useSettings({ providers: { glm: { apiKey: "g", model: "glm-5.3-flash" } } });
    assert.equal(resolveProvider("glm").contextWindow, undefined);
    assert.equal(resolveProvider("glm", "glm-5.3").contextWindow, 1_000_000);
  });

  test("自定义厂家：anthropic 默认 x-api-key，openai 默认 bearer", () => {
    useSettings({
      providers: {
        mine: { protocol: "anthropic", baseURL: "https://a.example", apiKey: "a", model: "m" },
        other: { protocol: "openai", baseURL: "https://o.example", apiKey: "o", model: "m" },
        forced: { protocol: "anthropic", baseURL: "https://f.example", apiKey: "f", model: "m", auth: "bearer" },
      },
    });
    assert.equal(resolveProvider("mine").auth, "x-api-key");
    assert.equal(resolveProvider("other").auth, "bearer");
    assert.equal(resolveProvider("forced").auth, "bearer");
    assert.equal(resolveProvider("mine").contextWindow, undefined);
  });

  test("自定义厂家可以用 models 清单给默认模型", () => {
    useSettings({ providers: { mine: { protocol: "openai", baseURL: "https://x", apiKey: "k", models: [{ id: "first" }, { id: "second" }] } } });
    assert.equal(resolveProvider("mine").model, "first");
  });
});

describe("resolveProvider 报错", () => {
  test("不认识的厂家", () => {
    assert.throws(() => resolveProvider("nope"), (e: Error) => e.message.startsWith('unknown provider "nope" (catalog: deepseek / kimi / glm'));
  });

  test("没有 key", () => {
    useSettings({ providers: { deepseek: { model: "deepseek-v4-pro" } } });
    assert.throws(() => resolveProvider("deepseek"), { message: 'provider "deepseek" has no API key — run ti setup' });
  });

  test("不读环境变量里的 key", () => {
    process.env.DEEPSEEK_API_KEY = "from-env";
    process.env.OPENAI_API_KEY = "from-env";
    try {
      assert.throws(() => resolveProvider("deepseek"), /has no API key/);
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.OPENAI_API_KEY;
    }
  });

  test("自定义厂家缺地址或模型", () => {
    useSettings({
      providers: {
        nourl: { protocol: "openai", apiKey: "k", model: "m" },
        nomodel: { protocol: "openai", apiKey: "k", baseURL: "https://x" },
      },
    });
    const missing = (n: string) => `provider "${n}" is missing model or baseURL — edit ${settingsFile} or run ti setup`;
    assert.throws(() => resolveProvider("nourl"), { message: missing("nourl") });
    assert.throws(() => resolveProvider("nomodel"), { message: missing("nomodel") });
  });
});

describe("列表", () => {
  test("listProviderNames 只列能用的：目录顺序在前，自定义在后", () => {
    useSettings({
      providers: {
        custom: { protocol: "openai", baseURL: "https://x", apiKey: "k", model: "m" },
        broken: { protocol: "openai", apiKey: "k" },
        glm: { apiKey: "g" },
        deepseek: { apiKey: "d" },
      },
    });
    assert.deepEqual(listProviderNames(), ["deepseek", "glm", "custom"]);
    useSettings({});
    assert.deepEqual(listProviderNames(), []);
  });

  test("isProviderReady", () => {
    useSettings({ providers: { kimi: { apiKey: "k" } } });
    assert.equal(isProviderReady("kimi"), true);
    assert.equal(isProviderReady("deepseek"), false);
    assert.equal(isProviderReady(undefined), false);
    assert.equal(isProviderReady("nope"), false);
  });

  test("listModels：settings 里的清单，当前模型不在清单里时排到最前；没写就是空", () => {
    useSettings({ providers: { deepseek: { apiKey: "d", model: "picked", models: [{ id: "a" }, { id: "b" }] } } });
    assert.deepEqual(listModels("deepseek"), ["picked", "a", "b"]);
    useSettings({ providers: { deepseek: { apiKey: "d", model: "a", models: [{ id: "a" }, { id: "b" }] } } });
    assert.deepEqual(listModels("deepseek"), ["a", "b"]);
    useSettings({ providers: { deepseek: { apiKey: "d" } } });
    assert.deepEqual(listModels("deepseek"), []);
    assert.deepEqual(listModels("unknown"), []);
  });
});

test("setProvider 与 getProvider", () => {
  useSettings({ providers: { deepseek: { apiKey: "d" } } });
  const p = resolveProvider("deepseek");
  setProvider(p);
  assert.equal(getProvider(), p);
});
