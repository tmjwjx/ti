/**
 * write 工具：创建或覆盖文件；父目录不存在时自动递归创建（pi 同款行为）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

// 相对路径一律解析到进程启动目录（cwd），与 pi 的 resolveToCwd 一致
const resolvePath = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

export async function writeTool(input: any): Promise<string> {
  const p = resolvePath(String(input.path));
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, String(input.content), "utf8");
  return `wrote ${Buffer.byteLength(String(input.content))} bytes to ${input.path}`;
}
