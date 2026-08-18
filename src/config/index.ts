/**
 * 配置适配层：内置预设、~/.ti/settings.json 加载、provider 解析与当前 provider 状态。
 *
 * 参考 pi 的 ~/.pi/agent/settings.json：个人配置放 ~/.ti/settings.json，例如：
 *   { "provider": "deepseek",
 *     "providers": { "deepseek":  { "model": "deepseek-chat", "apiKey": "sk-..." },
 *                    "anthropic": { "baseURL": "https://api.kimi.com/coding/", "model": "k3" } } }
 * 解析优先级（高 → 低）：CLI 参数 > 环境变量 > ~/.ti/settings.json > 内置预设
 *
 * 本模块持有全局可变状态之一：当前 provider（REPL /model 命令可切换）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Protocol, ProviderConf } from "../types.ts";

export const SETTINGS_PATH = `${homedir()}/.ti/settings.json`;

/** 内置预设：protocol/baseURL/model 的默认值，均可被配置文件与环境变量覆盖 */
export const PRESETS: Record<string, { protocol: Protocol; baseURL: string; model: string }> = {
  deepseek: { protocol: "openai", baseURL: "https://api.deepseek.com", model: "deepseek-chat" },
  anthropic: { protocol: "anthropic", baseURL: "https://api.anthropic.com", model: "k3" },
};

/** 读取 ~/.ti/settings.json；不存在或解析失败都按空配置处理（纯 env 也能跑） */
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
 * modelOverride 只来自 CLI -m/--model（最高优先级）；TI_MODEL 其次；
 * anthropic 协议还认 ANTHROPIC_MODEL。key 解析见下方注释。
 */
export function resolveProvider(name: string, modelOverride?: string): ProviderConf {
  const conf = { ...(PRESETS[name] ?? {}), ...(settings.providers?.[name] ?? {}) };
  if (!conf.protocol)
    fail(`unknown provider "${name}"（内置预设：${Object.keys(PRESETS).join(" / ")}，或在 ${SETTINGS_PATH} 的 providers 里自定义）`);
  const isAnth = conf.protocol === "anthropic";
  const baseURL = (process.env.TI_BASE_URL ?? (isAnth ? process.env.ANTHROPIC_BASE_URL : process.env.OPENAI_BASE_URL) ?? conf.baseURL).replace(/\/+$/, "");
  const model = modelOverride ?? process.env.TI_MODEL ?? (isAnth ? process.env.ANTHROPIC_MODEL : undefined) ?? conf.model;
  // 密钥解析：env 优先于配置文件。anthropic 协议按 env 变量种类决定鉴权风格；
  // 配置文件里的 apiKey 默认 x-api-key，可用 "auth": "bearer" 覆盖（如 Kimi 端点）
  let apiKey: string | undefined;
  let auth: "bearer" | "x-api-key" = conf.auth ?? (isAnth ? "x-api-key" : "bearer");
  if (isAnth) {
    if (process.env.ANTHROPIC_AUTH_TOKEN) { apiKey = process.env.ANTHROPIC_AUTH_TOKEN; auth = "bearer"; }
    else if (process.env.ANTHROPIC_API_KEY) { apiKey = process.env.ANTHROPIC_API_KEY; auth = "x-api-key"; }
    else apiKey = conf.apiKey;
  } else {
    apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY ?? conf.apiKey;
  }
  if (!apiKey)
    fail(`provider "${name}" 没有 API key：请 export ${isAnth ? "ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY" : "DEEPSEEK_API_KEY"}，或在 ${SETTINGS_PATH} 的 providers.${name}.apiKey 里配置`);
  return { name, protocol: conf.protocol, baseURL, model, apiKey, auth };
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
