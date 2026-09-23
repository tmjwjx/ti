// 跑 shell，stdout 与 stderr 合并返回，带退出码
import { spawn } from "node:child_process";
import { truncate } from "./truncate.ts";

// 跑一条 shell。打断或超时杀掉整条命令，连同它起的子进程（管道、后台、复合命令）
export function bashTool(input: any, abort?: AbortSignal): Promise<string> {
  return new Promise((done) => {
    // 第一个参数是整条命令；shell:true 才走 sh -c
    // detached：在 POSIX 上自成一个进程组，kill(-pid) 才能连子进程一起杀。只杀 sh 的话，
    // 子进程还占着输出管道，close 要等它自己跑完
    const posix = process.platform !== "win32";
    const child = spawn(String(input.command), { shell: true, detached: posix });
    let out = "";
    let reason: "interrupted" | "timeout" | undefined;
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (posix && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // 已经退出
      }
    };
    const kill = (why: "interrupted" | "timeout") => {
      if (reason) return;
      reason = why;
      signal("SIGTERM");
      // unref：别因为这个 2s 定时器把进程卡住
      setTimeout(() => signal("SIGKILL"), 2000).unref();
    };
    const onAbort = () => kill("interrupted");
    // ti 自己退出时别留下还在跑的命令
    const onExit = () => signal("SIGKILL");
    const timer = input.timeout ? setTimeout(() => kill("timeout"), Number(input.timeout) * 1000) : undefined;
    if (abort?.aborted) onAbort();
    else abort?.addEventListener("abort", onAbort, { once: true });
    process.once("exit", onExit);
    // 结束时撤掉计时器和监听。起不来走 error，正常结束走 close，两边都要撤
    const cleanup = () => {
      clearTimeout(timer);
      abort?.removeEventListener("abort", onAbort);
      process.removeListener("exit", onExit);
    };
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (e) => {
      cleanup();
      done(`Error: ${e.message}`);
    });
    child.on("close", (code, sig) => {
      cleanup();
      let tail = code ? `\n[exit code ${code}]` : "";
      if (sig) tail += `\n[killed by ${sig}${reason ? ` (${reason})` : ""}]`;
      done((truncate(out.trimEnd()) || "(no output)") + tail);
    });
  });
}
