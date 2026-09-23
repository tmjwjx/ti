// 内部消息与运行配置。各家 API 的线格式在 llm 里翻译，不绑在这里

export type Protocol = "anthropic" | "openai";

export interface ProviderConf {
  name: string;
  protocol: Protocol;
  baseURL: string;
  model: string;
  apiKey?: string;
  auth: "bearer" | "x-api-key"; // anthropic 官方用 x-api-key，Kimi 等用 Bearer
  contextWindow?: number; // 模型上下文窗口（token）。没有就不自动压缩
}

export type TextContent = { type: "text"; text: string };
// arguments 是 parse 后的对象，不是线上的 JSON 字符串
export type ToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, any> };

// stop 正常结束，length 输出触达上限，toolUse 要调工具
// incomplete 流未给出结束原因，badArgs 有正式 tool 结束但参数解不开
// aborted 用户打断。发请求时整条跳过，不当成模型说过的话
export type StopReason = "stop" | "length" | "toolUse" | "incomplete" | "badArgs" | "aborted";

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

// 压缩摘要。只存正文和代码统计的文件清单，前后缀在发请求时加
export type SummaryMessage = {
  role: "summary";
  text: string;
  files: { read: string[]; modified: string[] };
};

// 用户 /名字 调用的 skill。body 是调用那一刻读到的全文，之后 SKILL.md 改了也不影响
export type SkillMessage = {
  role: "skill";
  name: string;
  path: string;
  body: string;
  args: string;
};

// 协议认得的三种。summary、skill、aborted 在 callLLM 里先翻成这三种
export type LlmMessage = UserMessage | AssistantMessage | ToolResultMessage;

export type Message = LlmMessage | SummaryMessage | SkillMessage;
