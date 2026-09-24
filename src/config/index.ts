// 内置目录 + ~/.ti/settings.json + 当前 provider
// 字段优先级：CLI > 文件里写了的 > 代码目录
// 不读环境变量的值
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { Protocol, ProviderConf } from "../types.ts";

export const SETTINGS_PATH = `${homedir()}/.ti/settings.json`;

// 目录里的默认项
export type CatalogEntry = {
  label: string;
  protocol: Protocol;
  baseURL: string;
  auth: "bearer" | "x-api-key";
  models: { id: string; contextWindow?: number }[];
};

// 协议和默认地址写在这里，界面不出现协议选项
export const CATALOG: Record<string, CatalogEntry> = {
  deepseek: {
    label: "DeepSeek",
    protocol: "openai",
    baseURL: "https://api.deepseek.com",
    auth: "bearer",
    models: [
      { id: "deepseek-v4-flash", contextWindow: 1_000_000 },
      { id: "deepseek-v4-pro", contextWindow: 1_000_000 },
    ],
  },
  kimi: {
    label: "Kimi",
    protocol: "anthropic",
    baseURL: "https://api.kimi.com/coding",
    auth: "bearer",
    models: [{ id: "kimi-k3", contextWindow: 1_000_000 }],
  },
  glm: {
    label: "GLM",
    protocol: "openai",
    baseURL: "https://open.bigmodel.cn/api/coding/paas/v4",
    auth: "bearer",
    // glm-5.3-flash 官方没单列窗口，不写 contextWindow，自动压缩关掉
    models: [{ id: "glm-5.3-flash" }, { id: "glm-5.3", contextWindow: 1_000_000 }],
  },
};

// 文件在但读不了或解析不了时记下原因。有这个标记就不要保存
let settingsError: string | undefined;

// 读 settings。只有文件不存在才当成空配置
export function loadSettings(): any {
  let raw: string;
  try {
    raw = readFileSync(SETTINGS_PATH, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      settingsError = undefined;
      return {};
    }
    settingsError = e instanceof Error ? e.message : String(e);
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    settingsError = undefined;
    return parsed;
  } catch (e) {
    settingsError = e instanceof Error ? e.message : String(e);
    return {};
  }
}

export let settings = loadSettings();

// 改权限，失败就忽略
function chmodQuiet(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // EPERM 或只读盘：留下现状，不要崩界面
  }
}

// 整份 settings 落盘。上次读失败时不写，避免用空内容盖掉原文件
export function saveSettings(): void {
  if (settingsError) return;
  const dir = dirname(SETTINGS_PATH);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  // 新建时 mode 可能被 umask 放宽；已有 0644 也要收紧
  chmodQuiet(dir, 0o700);
  chmodQuiet(SETTINGS_PATH, 0o600);
}

// 从磁盘再读 settings
export function reloadSettings(): void {
  settings = loadSettings();
}

// 合并写入一家并设为当前
export function writeProvider(name: string, patch: Record<string, unknown>): void {
  settings.providers ??= {};
  // 浅合并：没写进 patch 的字段留下。patch 里若是 undefined 仍会盖掉，调用方不要传空字段
  settings.providers[name] = { ...settings.providers[name], ...patch };
  settings.provider = name;
  saveSettings();
}

// 配置错误
export function fail(msg: string): never {
  throw new Error(msg);
}

// 已写入 settings、能用的厂家名
export function listProviderNames(): string[] {
  // 并上目录名，是为了顺序稳定；没 key 的会被 isProviderReady 滤掉
  const names = new Set([...Object.keys(CATALOG), ...Object.keys(settings.providers ?? {})]);
  return [...names].filter((n) => isProviderReady(n));
}

// 这家已写入 settings 的模型 id
export function listModels(name: string): string[] {
  const providerSettings = settings.providers?.[name] ?? {};
  const ids = (providerSettings.models ?? []).map((m: { id: string }) => m.id);
  if (providerSettings.model && !ids.includes(providerSettings.model)) ids.unshift(providerSettings.model);
  return ids;
}

// 把目录默认值和 settings 里这家的字段合成一份能发请求的配置
export function resolveProvider(name: string, modelOverride?: string): ProviderConf {
  const catalog = CATALOG[name];
  const providerSettings = settings.providers?.[name] ?? {};
  // settings 里写了的字段盖目录。目录项 setup 不写 protocol、baseURL，这两项走 catalog
  const protocol = providerSettings.protocol ?? catalog?.protocol;
  if (!protocol)
    fail(`unknown provider "${name}" (catalog: ${Object.keys(CATALOG).join(" / ")}, or add providers.${name} in ${SETTINGS_PATH})`);
  const models: { id: string }[] = providerSettings.models ?? catalog?.models ?? [];
  // /model 只改当前，不改清单；-m 只这一进程，不写回 settings
  const model = modelOverride ?? providerSettings.model ?? models[0]?.id;
  const baseURL = (providerSettings.baseURL ?? catalog?.baseURL ?? "").replace(/\/+$/, "");
  if (!model || !baseURL)
    fail(`provider "${name}" is missing model or baseURL — edit ${SETTINGS_PATH} or run ti setup`);
  const apiKey = providerSettings.apiKey;
  if (!apiKey)
    fail(`provider "${name}" has no API key — run ti setup`);
  // settings 或目录写了 auth 用那个；否则 anthropic 默认 x-api-key，其余 bearer
  const auth: "bearer" | "x-api-key" = providerSettings.auth ?? catalog?.auth ?? (protocol === "anthropic" ? "x-api-key" : "bearer");
  const contextWindow = contextWindowFor(name, model);
  return { name, protocol, baseURL, model, apiKey, auth, contextWindow };
}

// 选中模型的窗口。settings 里写了的优先，否则用目录。都没有就是 undefined
function contextWindowFor(name: string, modelId: string): number | undefined {
  const saved = (settings.providers?.[name]?.models ?? []).find((m: { id: string; contextWindow?: number }) => m.id === modelId);
  if (typeof saved?.contextWindow === "number") return saved.contextWindow;
  return CATALOG[name]?.models.find((m) => m.id === modelId)?.contextWindow;
}

// 这家配置是否完整能用
export function isProviderReady(name: string | undefined): boolean {
  if (!name) return false;
  try {
    resolveProvider(name);
    return true;
  } catch {
    return false;
  }
}

let provider: ProviderConf;

// 记下进程内当前厂家
export function setProvider(p: ProviderConf): void {
  provider = p;
}

// 进程内当前厂家
export function getProvider(): ProviderConf {
  return provider;
}
