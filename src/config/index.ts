/**
 * 配置适配层：内置预设、~/.ti/settings.json、当前 provider 状态。
 *
 * 参考 pi：一家 provider 一份 models: [{ id }]，默认用第一项。
 * 端点 / 模型 / key / 选用哪家都走 settings 或 CLI，不采用环境变量的值。
 *
 *   { "provider": "deepseek",
 *     "providers": { "deepseek":  { "apiKey": "sk-..." },
 *                    "anthropic": { "baseURL": "https://api.kimi.com/coding/", "model": "k3", "auth": "bearer", "apiKey": "..." } } }
 *
 * 优先级：CLI（--provider / -m）> ~/.ti/settings.json > 内置预设。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Protocol, ProviderConf } from "../types.ts";

export const SETTINGS_PATH = `${homedir()}/.ti/settings.json`;

type ProviderPreset = { protocol: Protocol; baseURL: string; models: { id: string }[] };

/** 内置预设：协议、端点、模型清单（第一项为默认） */
export const PRESETS: Record<string, ProviderPreset> = {
  deepseek: {
    protocol: "openai",
    baseURL: "https://api.deepseek.com",
    models: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }],
  },
  anthropic: {
    protocol: "anthropic",
    baseURL: "https://api.anthropic.com",
    models: [{ id: "k3" }],
  },
};

/** 读取 ~/.ti/settings.json；不存在或解析失败都按空配置处理 */
export function loadSettings(): any {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** 启动时加载一次，全进程共享（REPL /model 需要看 settings.providers 判断名字） */
export const settings = loadSettings();

export function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/**
 * 按名字解析出完整的 provider 配置。
 * 模型：CLI -m > 文件 model > 清单第一项。端点 / key：文件 > 预设。
 */
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

// -------- 当前 provider（全局可变状态之一）
// 启动时由 main 解析并 setProvider；REPL 里 /model 可随时切换。
let provider: ProviderConf;

export function setProvider(p: ProviderConf): void {
  provider = p;
}

export function getProvider(): ProviderConf {
  return provider;
}
