/**
 * 领域模型（纯类型，无任何运行时代码）。
 * 内部统一使用 Anthropic 风格的 content block（内容块）结构；
 * OpenAI 协议路径在收发边界做双向转换，agent 循环与工具层无感知。
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

export type TextBlock = { type: "text"; text: string };
// 模型发起的工具调用：id 用于把执行结果关联回这次调用；input 是解析后的参数对象
export type ToolUse = { type: "tool_use"; id: string; name: string; input: any };
// 工具执行结果：is_error=true 告诉模型这次调用失败了，模型会据此自我纠正
export type ToolResult = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export type Block = TextBlock | ToolUse | ToolResult;

// 对话消息：REPL 用户输入用纯字符串即可；assistant 消息与 tool_result 回灌用块数组
export type Message = { role: "user" | "assistant"; content: string | Block[] };

/** 一次 LLM 调用的统一返回：完整 assistant 内容块 + 停止原因 + token 用量 */
export type LlmResult = { content: Block[]; stopReason: string; usage: { input: number; output: number } };
