/**
 * 工具输出头部截断（对应 pi 的 truncate.ts）：先按行数截，再按字节截，超出时追加说明。
 * 防止 cat 大文件、长跑命令输出等内容撑爆模型上下文窗口。
 */
export const MAX_LINES = 2000; // 最多保留 2000 行（与 pi 默认值一致）
export const MAX_BYTES = 50 * 1024; // 且最多保留 50KB（同上）

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
