/** 先按行数截，再按字节截，避免工具输出撑爆上下文。 */
export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;

export function truncate(text: string): string {
  const lines = text.split("\n");
  let out = lines.slice(0, MAX_LINES).join("\n");
  let note = lines.length > MAX_LINES ? `\n... [truncated: showing ${MAX_LINES} of ${lines.length} lines]` : "";
  if (Buffer.byteLength(out) > MAX_BYTES) {
    out = Buffer.from(out).subarray(0, MAX_BYTES).toString("utf8");
    note = `\n... [truncated: output exceeded ${MAX_BYTES / 1024}KB]`;
  }
  return out + note;
}
