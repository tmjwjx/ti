// 创建或覆盖文件；父目录不存在就建
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const resolvePath = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

export async function writeTool(input: any): Promise<string> {
  const p = resolvePath(String(input.path));
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, String(input.content), "utf8");
  return `wrote ${Buffer.byteLength(String(input.content))} bytes to ${input.path}`;
}
