/**
 * read 工具：带行号读文件；offset 从 1 开始，配合 limit 分页浏览大文件。
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { truncate } from "./truncate.ts";

// 相对路径一律解析到进程启动目录（cwd），与 pi 的 resolveToCwd 一致
const resolvePath = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

export async function readTool(input: any): Promise<string> {
  // 读全文 → 按 offset/limit 切片 → 加 cat -n 风格行号（右对齐 6 位 + 制表符）
  // Number() 兜底：模型偶尔会把数字参数传成字符串
  const all = (await readFile(resolvePath(String(input.path)), "utf8")).split("\n");
  const offset = Math.max(1, Number(input.offset) || 1);
  const limit = Number(input.limit) || undefined;
  const slice = all.slice(offset - 1, limit ? offset - 1 + limit : undefined);
  const numbered = slice.map((l, i) => `${String(offset + i).padStart(6)}\t${l}`).join("\n");
  return truncate(numbered || `(empty file, or offset ${offset} past end of file)`);
}
