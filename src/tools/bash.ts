/**
 * bash 工具：执行 shell 命令，返回合并的 stdout/stderr 与退出码。
 */
import { spawn } from "node:child_process";
import { truncate } from "./truncate.ts";

export function bashTool(input: any): Promise<string> {
  return new Promise((done) => {
    // spawn + shell:true 走系统 shell（支持管道、重定向等）；
    // timeout 到期后 Node 自动向进程发 SIGTERM
    const child = spawn(String(input.command), {
      shell: true,
      timeout: input.timeout ? Number(input.timeout) * 1000 : undefined,
    });
    let out = "";
    // stdout/stderr 合并收集：模型通常不关心分流，合并更省上下文
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (e) => done(`Error: ${e.message}`));
    child.on("close", (code, signal) => {
      // 附上退出码 / 被信号杀死的标记，帮助模型判断命令成败
      let tail = code ? `\n[exit code ${code}]` : "";
      if (signal) tail += `\n[killed by ${signal}${input.timeout ? " (timeout)" : ""}]`;
      done((truncate(out.trimEnd()) || "(no output)") + tail);
    });
  });
}
