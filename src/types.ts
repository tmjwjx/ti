/** 内部消息与运行配置。各家 API 的线格式在 llm/ 翻译，不绑在这里。 */

export type Protocol = "anthropic" | "openai";

export interface ProviderConf {
  name: string;
  protocol: Protocol;
  baseURL: string;
  model: string;
  apiKey?: string;
  auth: "bearer" | "x-api-key"; // anthropic 官方用 x-api-key，Kimi 等用 Bearer
}

export type TextContent = { type: "text"; text: string };
// arguments 是 parse 后的对象，不是线上的 JSON 字符串
export type ToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, any> };

/** stop 正常结束 / length 输出被截断 / toolUse 要调工具 */
export type StopReason = "stop" | "length" | "toolUse";

export type UserMessage = { role: "user"; content: string | TextContent[] };
export type AssistantMessage = {
  role: "assistant";
  content: (TextContent | ToolCall)[];
  stopReason: StopReason;
  usage: { input: number; output: number };
};
export type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean; // true 时模型应据此改参数重试
};

export type Message = UserMessage | AssistantMessage | ToolResultMessage;
