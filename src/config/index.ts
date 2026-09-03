/**
 * 预设 + ~/.ti/settings.json + 当前 provider。
 * 优先级：CLI（--provider / -m）> settings.json > 预设。不读环境变量的值。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { Protocol, ProviderConf } from "../types.ts";

export const SETTINGS_PATH = `${homedir()}/.ti/settings.json`;

type ProviderPreset = { protocol: Protocol; baseURL: string; models: { id: string }[] };

/** 第一项是默认模型 */
export const PRESETS: Record<string, ProviderPreset> = {
  deepseek: {
    protocol: "openai",
    baseURL: "https://api.deepseek.com",
    models: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }],
  },
};

const DEFAULT_SETTINGS = {
  provider: "deepseek",
  providers: { deepseek: { apiKey: "" } },
};

export function loadSettings(): any {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

export let settings = loadSettings();

/** 没有文件就建一份模板。已有文件不碰。--help 不要走这里。 */
export function ensureSettings(): void {
  if (existsSync(SETTINGS_PATH)) return;
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n", "utf8");
  settings = loadSettings();
  console.error(`已创建 ${SETTINGS_PATH}，请填写 providers.deepseek.apiKey`);
}

export function fail(msg: string): never {
  throw new Error(msg);
}

/** 模型：-m > 文件 model > 清单第一项。端点 / key：文件 > 预设。 */
export function resolveProvider(name: string, modelOverride?: string): ProviderConf {
  const preset = PRESETS[name];
  const file = settings.providers?.[name] ?? {};
  const protocol = file.protocol ?? preset?.protocol;
  if (!protocol)
    fail(`unknown provider "${name}"（内置预设：${Object.keys(PRESETS).join(" / ")}，或在 ${SETTINGS_PATH} 的 providers 里自定义）`);
  const isAnth = protocol === "anthropic";
  const models: { id: string }[] = file.models ?? preset?.models ?? [];
  const model = modelOverride ?? file.model ?? models[0]?.id;
  const baseURL = (file.baseURL ?? preset?.baseURL ?? "").replace(/\/+$/, "");
  if (!model || !baseURL)
    fail(`provider "${name}" 缺少 model 或 baseURL：请在 ${SETTINGS_PATH} 的 providers.${name} 里配置`);
  const apiKey = file.apiKey;
  const auth: "bearer" | "x-api-key" = file.auth ?? (isAnth ? "x-api-key" : "bearer");
  if (!apiKey)
    fail(`provider "${name}" 没有 API key：请在 ${SETTINGS_PATH} 的 providers.${name}.apiKey 里配置`);
  return { name, protocol, baseURL, model, apiKey, auth };
}

let provider: ProviderConf;

export function setProvider(p: ProviderConf): void {
  provider = p;
}

export function getProvider(): ProviderConf {
  return provider;
}
