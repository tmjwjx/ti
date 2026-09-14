// 一处或多处替换。各条对着同一份原文定位，区间不得重叠
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const resolvePath = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

// 对着同一份原文定位多处替换并写回
export async function editTool(input: any): Promise<string> {
  const p = resolvePath(String(input.path));
  const original = await readFile(p, "utf8");
  if (!Array.isArray(input.edits) || input.edits.length === 0) throw new Error("edits must be a non-empty array");

  const located: { start: number; oldLen: number; newText: string }[] = [];
  for (const e of input.edits) {
    if (typeof e.oldText !== "string" || typeof e.newText !== "string") {
      throw new Error("oldText and newText must be strings");
    }
    const { oldText, newText } = e;
    const start = original.indexOf(oldText);
    if (start < 0) throw new Error(`oldText not found in ${input.path}: ${JSON.stringify(oldText.slice(0, 80))}`);
    if (original.indexOf(oldText, start + 1) >= 0) {
      throw new Error(`oldText occurs more than once in ${input.path}; it must be unique`);
    }
    located.push({ start, oldLen: oldText.length, newText });
  }

  for (let i = 0; i < located.length; i++) {
    const a = located[i];
    for (let j = i + 1; j < located.length; j++) {
      const b = located[j];
      if (a.start < b.start + b.oldLen && b.start < a.start + a.oldLen) {
        throw new Error(`overlapping edits in ${input.path}`);
      }
    }
  }

  // 从后往前拼，前面的偏移不受后面替换影响
  located.sort((a, b) => b.start - a.start);
  let s = original;
  for (const { start, oldLen, newText } of located) {
    s = s.slice(0, start) + newText + s.slice(start + oldLen);
  }

  await writeFile(p, s, "utf8");
  return `applied ${input.edits.length} edit(s) to ${input.path}`;
}
