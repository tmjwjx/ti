// 配一家 provider
import type { Protocol } from "../types.ts";
import { CATALOG, listProviderNames, settings, writeProvider } from "../config/index.ts";
import { input, select } from "./form.ts";
import type { Tui, TuiChoice } from "./tui.ts";

// 选项里「其它」的占位，不当厂家名写入
const CUSTOM = "__custom__";

// while 与 switch 的当前页
type Screen =
  | "intent"
  | "vendor"
  | "customName"
  | "customProtocol"
  | "customUrl"
  | "model"
  | "customModel"
  | "key";

type Intent = "add-model" | "add-provider" | "change-key";

// 各页填过的字段，save 时一次写入
type Draft = {
  kind: "catalog" | "custom";
  name?: string;
  protocol?: Protocol;
  baseURL?: string;
  model?: string;
};

// 配置向导
export async function runSetup(tui?: Tui): Promise<"saved" | "cancel"> {
  // 有 TUI 挂底栏；没有（管道或非 TTY 兜底）才清屏走 form
  const pick = <T>(title: string, choices: TuiChoice<T>[], initial = 0) =>
    tui ? tui.pick(title, choices, initial) : select(title, choices, initial);
  const ask = (title: string, opts?: { secret?: boolean; placeholder?: string }) =>
    tui ? tui.ask(title, opts) : input(title, opts);

  const ready = listProviderNames();
  // settings.provider 可能还没 ready（半截配置），退回第一家能用的
  const current = ready.includes(settings.provider) ? settings.provider : ready[0];
  let screen: Screen = ready.length ? "intent" : "vendor";
  let intent: Intent | undefined;
  const d: Draft = { kind: "catalog" };

  while (true) {
    switch (screen) {
      case "intent": { // 已有配置时先问要干什么，避免每次都走完整向导
        const curLabel = CATALOG[current!]?.label ?? current;
        const v = await pick("Setup", [
          { value: "add-model" as Intent, label: `Add model to ${curLabel}` },
          { value: "add-provider" as Intent, label: "Add provider" },
          { value: "change-key" as Intent, label: "Change API key" },
        ]);
        // undefined = Esc。意图页是第一页，直接 cancel，不回退
        if (v === undefined) return "cancel";
        intent = v;
        if (v === "add-model") {
          d.name = current;
          d.kind = CATALOG[current!] ? "catalog" : "custom";
          screen = CATALOG[current!] ? "model" : "customModel";
          break;
        }
        if (v === "change-key") {
          // 只有一家就不用再选
          if (ready.length === 1) {
            fillExisting(d, ready[0]!);
            screen = "key";
            break;
          }
          screen = "vendor";
          break;
        }
        screen = "vendor";
        break;
      }

      case "vendor": { // 选择供应商
        if (intent === "change-key") {
          const v = await pick(
            "Provider",
            ready.map((n) => ({
              value: n,
              label: CATALOG[n]?.label ?? n,
              current: n === settings.provider,
            })),
            Math.max(0, ready.indexOf(settings.provider)),
          );
          if (v === undefined) {
            screen = "intent";
            break;
          }
          fillExisting(d, v);
          screen = "key";
          break;
        }
        const v = await pick("Provider", [
          { value: "deepseek", label: "DeepSeek" },
          { value: "kimi", label: "Kimi" },
          { value: "glm", label: "GLM" },
          { value: CUSTOM, label: "Custom" },
        ]);
        if (v === undefined) {
          // 从意图进来的回意图；冷启动没有意图页，Esc 就是取消
          if (ready.length) {
            screen = "intent";
            break;
          }
          return "cancel";
        }
        if (v === CUSTOM) {
          d.kind = "custom";
          d.name = undefined;
          screen = "customName";
          break;
        }
        // 目录项不写协议、地址，避免盖住 CATALOG
        d.kind = "catalog";
        d.name = v;
        d.protocol = undefined;
        d.baseURL = undefined;
        screen = "model";
        break;
      }

      case "customName": { // 输入自定义名称
        const n = await ask("Name", { placeholder: "myapi" });
        if (n === undefined) {
          screen = "vendor";
          break;
        }
        const name = n.trim();
        if (!name) break; // 空回车留在本页，和 Esc 回上一页分开。
        d.name = name;
        screen = "customProtocol";
        break;
      }

      case "customProtocol": { // 选择协议
        const p = await pick("Protocol", [
          { value: "openai" as Protocol, label: "OpenAI" },
          { value: "anthropic" as Protocol, label: "Anthropic" },
        ]);
        if (p === undefined) {
          screen = "customName";
          break;
        }
        d.protocol = p;
        screen = "customUrl";
        break;
      }

      case "customUrl": { // 输入基础 URL
        const u = await ask("Base URL", { placeholder: "https://" });
        if (u === undefined) {
          screen = "customProtocol";
          break;
        }
        // 去掉 URL 末尾斜杠，后面拼路径才不会双斜杠
        const url = u.trim().replace(/\/+$/, "");
        if (!url) break;
        d.baseURL = url;
        screen = "customModel";
        break;
      }

      case "model": { // 选择模型
        const ids = CATALOG[d.name!]?.models.map((m) => m.id) ?? [];
        const v = await pick("Model", [
          ...ids.map((id) => ({ value: id, label: id })),
          { value: CUSTOM, label: "Other" },
        ]);
        if (v === undefined) {
          screen = intent === "add-model" ? "intent" : "vendor";
          break;
        }
        if (v === CUSTOM) {
          screen = "customModel";
          break;
        }
        d.model = v;
        if (skipKey(d, intent)) {
          save(d, existingKey(d.name!)!);
          return "saved";
        }
        screen = "key";
        break;
      }

      case "customModel": { // 输入自定义模型
        const m = await ask("Model");
        if (m === undefined) {
          if (intent === "add-model") {
            screen = CATALOG[d.name!] ? "model" : "intent";
            break;
          }
          screen = d.kind === "custom" ? "customUrl" : "model";
          break;
        }
        const model = m.trim();
        if (!model) break;
        d.model = model;
        if (skipKey(d, intent)) {
          save(d, existingKey(d.name!)!);
          return "saved";
        }
        screen = "key";
        break;
      }

      case "key": { // 输入 API key
        const k = await ask("API key", { secret: true });
        if (k === undefined) {
          if (intent === "change-key") {
            screen = ready.length > 1 ? "vendor" : "intent";
            break;
          }
          // 模型不在目录清单里（手打），回到 customModel
          const typed =
            d.kind === "custom" || !CATALOG[d.name!]?.models.some((m) => m.id === d.model);
          screen = typed ? "customModel" : "model";
          break;
        }
        const apiKey = k.trim();
        if (!apiKey) break;
        save(d, apiKey);
        return "saved";
      }
    }
  }
}

// 用已有厂家填草稿
function fillExisting(d: Draft, name: string) {
  d.name = name;
  d.kind = CATALOG[name] ? "catalog" : "custom";
  d.model = settings.providers?.[name]?.model;
  d.protocol = settings.providers?.[name]?.protocol;
  d.baseURL = settings.providers?.[name]?.baseURL;
}

// 这家已写入的 API key
function existingKey(name: string): string | undefined {
  const k = settings.providers?.[name]?.apiKey;
  return typeof k === "string" && k.trim() ? k : undefined;
}

// 这次要不要跳过 key 页
function skipKey(d: Draft, intent: Intent | undefined): boolean {
  return intent !== "change-key" && !!d.name && !!existingKey(d.name);
}

// 把草稿写入 settings
function save(d: Draft, apiKey: string) {
  const name = d.name!;
  const providerSettings = settings.providers?.[name] ?? {};
  const models: { id: string }[] = [...(providerSettings.models ?? [])];
  if (providerSettings.model && !models.some((m) => m.id === providerSettings.model)) models.unshift({ id: providerSettings.model });
  if (d.model && !models.some((m) => m.id === d.model)) models.push({ id: d.model });
  if (!d.model) {
    writeProvider(name, { apiKey, models });
    return;
  }
  const id = d.model;
  if (d.kind === "custom") {
    // 给已有 custom 加模型时 protocol、url 没问，undefined 不能写进去盖掉
    const patch: Record<string, unknown> = { model: id, apiKey, models };
    if (d.protocol) patch.protocol = d.protocol;
    if (d.baseURL) patch.baseURL = d.baseURL;
    writeProvider(name, patch);
    return;
  }
  writeProvider(name, { apiKey, model: id, models });
}
