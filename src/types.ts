/**
 * 领域模型（纯类型，无任何运行时代码）。
 *
 * 内部消息格式是【自定义】的（pi 同款思路，参照 pi/packages/ai/src/types.ts），
 * 不绑定任何一家 API 的线格式；各家协议在 llm/ 边界做双向翻译。
 * 设计要点：
 *   - 内容块模型：assistant 消息里文本与工具调用混排保序，参数是解析好的对象
 *   - 工具结果是平铺的独立消息（OpenAI 路径 1:1 直通；Anthropic 路径在边界归并进 user 消息）
 *   - AssistantMessage 自带 usage/stopReason：session 落盘自解释，token 统计可从消息汇总
 *   - 自定义格式加可选字段向后兼容：将来接 reasoning/图片/Gemini 签名时直接扩展
 */

/** 传输协议：Anthropic Messages API / OpenAI chat/completions 兼容协议 */
export type Protocol = "anthropic" | "openai";

/** 解析后的 provider 运行配置：协议、端点、模型、鉴权方式与密钥 */
export interface ProviderConf {
  name: string;
  protocol: Protocol;
  baseURL: string;
  model: string;
  apiKey?: string;
  auth: "bearer" | "x-api-key"; // anthropic 协议两种风格：Bearer(Kimi 等) / x-api-key(官方)
}

// -------- 内容块（assistant 消息内混排，保序）
export type TextContent = { type: "text"; text: string };
// 模型发起的工具调用：id 用于把执行结果关联回这次调用；
// arguments 是解析后的参数对象（不是 OpenAI 线格式那种 JSON 字符串）
export type ToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, any> };

/** 停止原因归一化：stop 正常结束 / length 输出被截断 / toolUse 要调工具（各家方言在 llm 边界翻译） */
export type StopReason = "stop" | "length" | "toolUse";

// -------- 消息：三种角色的可辨识联合（pi 同款骨架），对话历史的最小完备集
// 用户消息：REPL 输入用纯字符串即可；TextContent[] 为多模态预留
export type UserMessage = { role: "user"; content: string | TextContent[] };
// 助手消息：内容块 + 本轮停止原因与 token 用量（落盘/统计都靠它）
export type AssistantMessage = {
  role: "assistant";
  content: (TextContent | ToolCall)[];
  stopReason: StopReason;
  usage: { input: number; output: number };
};
// 工具执行结果：平铺的独立消息，按 toolCallId 关联回调用；
// isError=true 告诉模型这次调用失败了，模型会据此自我纠正
export type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string; // 冗余存一份名字：session 落盘时可读（不用回查调用块）
  content: string;
  isError: boolean;
};

export type Message = UserMessage | AssistantMessage | ToolResultMessage;
