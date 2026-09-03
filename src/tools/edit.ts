/**
 * 一处或多处替换。oldText 必须与原文完全一致且只出现一次。
 * 所有 edits 都对原文件匹配，先全部校验再写回，避免改到一半。
 */
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const resolvePath = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

export async function editTool(input: any): Promise<string> {
  const p = resolvePath(String(input.path));
  const original = await readFile(p, "utf8");
  if (!Array.isArray(input.edits) || input.edits.length === 0) throw new Error("edits must be a non-empty array");
  for (const e of input.edits) {
    const n = original.split(e.oldText).length - 1;
    if (n === 0) throw new Error(`oldText not found in ${input.path}: ${JSON.stringify(String(e.oldText).slice(0, 80))}`);
    if (n > 1) throw new Error(`oldText occurs ${n} times in ${input.path}; it must be unique`);
  }
  let next = original;
  for (const e of input.edits) next = next.replace(e.oldText, e.newText);
  await writeFile(p, next, "utf8");
  return `applied ${input.edits.length} edit(s) to ${input.path}`;
}
