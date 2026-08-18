/**
 * edit 工具：一次调用可做多处替换。约束（也是 pi 的约束）：
 *   - oldText 必须与原文件逐字节一致（含缩进空白）
 *   - oldText 在文件里只能出现一次（唯一性），否则替换有歧义
 *   - 所有 edits 都针对「原文件」匹配，而不是逐个应用后的中间状态
 */
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

// 相对路径一律解析到进程启动目录（cwd），与 pi 的 resolveToCwd 一致
const resolvePath = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

export async function editTool(input: any): Promise<string> {
  const p = resolvePath(String(input.path));
  const original = await readFile(p, "utf8");
  if (!Array.isArray(input.edits) || input.edits.length === 0) throw new Error("edits must be a non-empty array");
  // 先在「原文件」上统一校验所有 oldText：不存在 → 报错；出现多次 → 报错。
  // 全部通过后再统一应用，避免改了一半留下半成品文件（pi 的同款策略）。
  for (const e of input.edits) {
    const n = original.split(e.oldText).length - 1; // 用 split 计数，无需转义正则
    if (n === 0) throw new Error(`oldText not found in ${input.path}: ${JSON.stringify(String(e.oldText).slice(0, 80))}`);
    if (n > 1) throw new Error(`oldText occurs ${n} times in ${input.path}; it must be unique`);
  }
  let next = original;
  for (const e of input.edits) next = next.replace(e.oldText, e.newText); // replace 只替换第一处，已校验唯一
  await writeFile(p, next, "utf8");
  return `applied ${input.edits.length} edit(s) to ${input.path}`;
}
