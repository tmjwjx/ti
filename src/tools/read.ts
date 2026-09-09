// 带行号读文件。offset 从 1 起，可和 limit 一起分页
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { truncate } from "./truncate.ts";

const resolvePath = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

export async function readTool(input: any): Promise<string> {
  const all = (await readFile(resolvePath(String(input.path)), "utf8")).split("\n");
  const offset = Math.max(1, Number(input.offset) || 1); // 模型有时把数字作成字符串
  const limit = Number(input.limit) || undefined;
  const slice = all.slice(offset - 1, limit ? offset - 1 + limit : undefined);
  const numbered = slice.map((l, i) => `${String(offset + i).padStart(6)}\t${l}`).join("\n");
  return truncate(numbered || `(empty file, or offset ${offset} past end of file)`);
}
