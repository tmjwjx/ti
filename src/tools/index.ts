/** 工具 schema + 按名分发。schema 原样给 Anthropic；OpenAI 在请求里再包一层 function。 */
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";
import { editTool } from "./edit.ts";
import { bashTool } from "./bash.ts";

export const TOOLS = [
  {
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
