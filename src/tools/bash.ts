/** 跑 shell，stdout/stderr 合并返回，带退出码。 */
import { spawn } from "node:child_process";
import { truncate } from "./truncate.ts";

export function bashTool(input: any): Promise<string> {
  return new Promise((done) => {
    const child = spawn(String(input.command), {
      shell: true,
      timeout: input.timeout ? Number(input.timeout) * 1000 : undefined,
    });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (e) => done(`Error: ${e.message}`));
    child.on("close", (code, signal) => {
      let tail = code ? `\n[exit code ${code}]` : "";
      if (signal) tail += `\n[killed by ${signal}${input.timeout ? " (timeout)" : ""}]`;
      done((truncate(out.trimEnd()) || "(no output)") + tail);
    });
  });
}
