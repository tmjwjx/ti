// 跑 shell，stdout 与 stderr 合并返回，带退出码。
import { spawn } from "node:child_process";
import { truncate } from "./truncate.ts";

// 跑一条 shell。失败也 resolve 字符串（要回灌模型）。
// abort 先 SIGTERM，2s 后再 SIGKILL，避免子进程挂死占着轮次。
export function bashTool(input: any, abort?: AbortSignal): Promise<string> {
  return new Promise((done) => {
    // 第一个参数是整条命令；shell:true 才走 sh -c。
    const child = spawn(String(input.command), {
      shell: true,
      timeout: input.timeout ? Number(input.timeout) * 1000 : undefined,
    });
    let out = "";
    const kill = () => {
      child.kill("SIGTERM");
      // unref：别因为这个 2s 定时器把进程卡住。
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    };
    if (abort?.aborted) kill();
    else abort?.addEventListener("abort", kill, { once: true });
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (e) => done(`Error: ${e.message}`));
    child.on("close", (code, sig) => {
      abort?.removeEventListener("abort", kill);
      let tail = code ? `\n[exit code ${code}]` : "";
      if (sig) tail += `\n[killed by ${sig}${abort?.aborted ? " (interrupted)" : input.timeout ? " (timeout)" : ""}]`;
      done((truncate(out.trimEnd()) || "(no output)") + tail);
    });
  });
}
