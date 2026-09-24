// 创建或覆盖文件；父目录不存在就建
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const resolvePath = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

export async function writeTool(input: any): Promise<string> {
  // 不是字符串就失败返回，避免把 undefined 写进文件。空字符串仍会清空文件
  if (typeof input.content !== "string") throw new Error("content must be a string");
  const p = resolvePath(String(input.path));
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, input.content, "utf8");
  return `wrote ${Buffer.byteLength(input.content)} bytes to ${input.path}`;
}
