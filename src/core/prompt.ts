/** 系统提示词。工具清单从 TOOLS 生成；有 AGENTS.md / CLAUDE.md 则追加。 */
import { readFile } from "node:fs/promises";
import { TOOLS } from "../tools/index.ts";

export async function buildSystemPrompt(): Promise<string> {
  let projectContext = "";
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      projectContext += `\n\n<project_context path="${file}">\n${await readFile(file, "utf8")}\n</project_context>`;
    } catch {
      /* 文件不存在则跳过 */
    }
  }

  const toolsList = TOOLS.map((t) => `- ${t.name}: ${t.description}`).join("\n");

  return `You are an expert coding assistant operating inside ti. You read, write and edit files, and run shell commands to get the job done.

Available tools:
${toolsList}

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files
- Use bash for file operations like ls, rg, find
- Prefer edit for targeted changes; use write for new files or full rewrites
- Verify your work: build/test after changing code when possible

Current working directory: ${process.cwd()}
Current date: ${new Date().toISOString().slice(0, 10)}${projectContext}`;
}

/*
  中文对照（不发给模型）：
  你是 ti 里的编程助手：读写改文件、跑命令。
  可用工具：由 TOOLS 的 name + description 生成。
  准则：简短；写出路径；用 bash 做 ls/rg/find；小改用 edit，新建或整文件用 write；能编测就编测。
  当前目录 / 日期；有 AGENTS.md 或 CLAUDE.md 再追加。
*/
