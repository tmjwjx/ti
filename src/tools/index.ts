/**
 * 工具 schema 定义 + runTool 分发。
 *
 * 工具定义格式：name + description + input_schema(JSON Schema)。
 * Anthropic 协议直接作为 tools 下发；OpenAI 协议在请求时包一层 {type:"function"}。
 * 4 个工具的参数名与描述逐一对齐 pi 的 read/write/edit/bash。
 *
 * runTool 返回值即 toolResult 的内容；抛出的异常会在 agentTurn 里被捕获
 * 并转成 isError=true 的 toolResult 消息回灌给模型（模型通常能据此自我纠正）。
 */
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";
import { editTool } from "./edit.ts";
import { bashTool } from "./bash.ts";

export const TOOLS = [
  {
    // read：带行号读文件；offset 从 1 开始，配合 limit 分页浏览大文件
    name: "read",
    description: "Read a text file with line numbers. Use offset/limit to page through large files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read (relative or absolute)" },
        offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
  },
  {
    // write：创建或覆盖文件；父目录不存在时自动递归创建
    name: "write",
    description: "Create or overwrite a file. Parent directories are created automatically.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to write (relative or absolute)" },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
    },
  },
  {
    // edit：一次调用可做多处替换。约束（也是 pi 的约束）：
    //   - oldText 必须与原文件逐字节一致（含缩进空白）
    //   - oldText 在文件里只能出现一次（唯一性），否则替换有歧义
    //   - 所有 edits 都针对「原文件」匹配，而不是逐个应用后的中间状态
    name: "edit",
    description:
      "Make one or more targeted replacements in a file. Each oldText must match the file content exactly (including whitespace) and occur exactly once. All edits are matched against the original file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
        edits: {
          type: "array",
          description: "Targeted replacements matched against the original file. Merge nearby changes into one edit; do not overlap.",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "Exact text to replace; must be unique in the file" },
              newText: { type: "string", description: "Replacement text" },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "edits"],
    },
  },
  {
    // bash：执行 shell 命令，返回合并的 stdout/stderr 与退出码；timeout 可选，默认不超时
    name: "bash",
    description: "Run a shell command and return its combined stdout/stderr and exit code.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
      },
      required: ["command"],
    },
  },
];

/** 按工具名分发到对应实现；未知工具抛错（由 agentTurn 转成错误回灌） */
export async function runTool(name: string, input: any): Promise<string> {
  switch (name) {
    case "read":
      return readTool(input);
    case "write":
      return writeTool(input);
    case "edit":
      return editTool(input);
    case "bash":
      return bashTool(input);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
