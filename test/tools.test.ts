// tools：read、write、edit、bash 在临时目录里的行为，以及输出截断
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolate } from "./helpers.ts";

const box = isolate();
const { runTool, TOOLS } = await import("../src/tools/index.ts");
const { truncate, MAX_LINES, MAX_BYTES } = await import("../src/tools/truncate.ts");

// 在项目目录里写一份文件
function put(name: string, text: string): string {
  const p = join(box.project, name);
  writeFileSync(p, text);
  return p;
}

describe("TOOLS 与 runTool", () => {
  test("四个工具的名字与必填字段", () => {
    assert.deepEqual(
      TOOLS.map((t) => [t.name, t.input_schema.required]),
      [
        ["read", ["path"]],
        ["write", ["path", "content"]],
        ["edit", ["path", "edits"]],
        ["bash", ["command"]],
      ],
    );
  });

  test("不认识的工具抛错", async () => {
    await assert.rejects(runTool("rm", {}), { message: "unknown tool: rm" });
  });
});

describe("read", () => {
  test("带 6 位右对齐行号和制表符", async () => {
    put("r.txt", "alpha\nbeta\ngamma");
    assert.equal(await runTool("read", { path: "r.txt" }), "     1\talpha\n     2\tbeta\n     3\tgamma");
  });

  test("offset 从 1 起，limit 限行数；字符串数字也认", async () => {
    put("page.txt", "1\n2\n3\n4\n5");
    assert.equal(await runTool("read", { path: "page.txt", offset: 2, limit: 2 }), "     2\t2\n     3\t3");
    assert.equal(await runTool("read", { path: "page.txt", offset: "4" }), "     4\t4\n     5\t5");
    assert.equal(await runTool("read", { path: "page.txt", offset: 0, limit: 1 }), "     1\t1");
  });

  test("绝对路径也能读", async () => {
    const p = put("abs.txt", "x");
    assert.equal(await runTool("read", { path: p }), "     1\tx");
  });

  test("offset 越过末尾给提示", async () => {
    put("short.txt", "only");
    assert.equal(await runTool("read", { path: "short.txt", offset: 10 }), "(empty file, or offset 10 past end of file)");
  });

  test("空文件读出一行空内容", async () => {
    put("empty.txt", "");
    assert.equal(await runTool("read", { path: "empty.txt" }), "     1\t");
  });

  test("文件不存在抛 ENOENT", async () => {
    await assert.rejects(runTool("read", { path: "nope.txt" }), { code: "ENOENT" });
  });

  test("超过 2000 行时截断并注明", async () => {
    put("big.txt", Array.from({ length: 2500 }, (_, i) => `l${i}`).join("\n"));
    const out = await runTool("read", { path: "big.txt" });
    assert.ok(out.endsWith("\n... [truncated: showing 2000 of 2500 lines]"));
  });
});

describe("write", () => {
  test("自动建父目录，返回 UTF-8 字节数", async () => {
    const out = await runTool("write", { path: "deep/er/w.txt", content: "中文ok" });
    assert.equal(out, "wrote 8 bytes to deep/er/w.txt");
    assert.equal(readFileSync(join(box.project, "deep/er/w.txt"), "utf8"), "中文ok");
  });

  test("覆盖已有文件", async () => {
    put("over.txt", "old content");
    await runTool("write", { path: "over.txt", content: "new" });
    assert.equal(readFileSync(join(box.project, "over.txt"), "utf8"), "new");
  });

  test("空内容也写", async () => {
    assert.equal(await runTool("write", { path: "zero.txt", content: "" }), "wrote 0 bytes to zero.txt");
  });
});

describe("edit", () => {
  test("单处替换", async () => {
    put("e1.txt", "hello world");
    assert.equal(await runTool("edit", { path: "e1.txt", edits: [{ oldText: "world", newText: "ti" }] }), "applied 1 edit(s) to e1.txt");
    assert.equal(readFileSync(join(box.project, "e1.txt"), "utf8"), "hello ti");
  });

  test("多处都对着原文定位：前一处的新文本不会被后一处匹配到", async () => {
    put("e2.txt", "foo bar");
    await runTool("edit", {
      path: "e2.txt",
      edits: [
        { oldText: "foo", newText: "bar" },
        { oldText: "bar", newText: "baz" },
      ],
    });
    assert.equal(readFileSync(join(box.project, "e2.txt"), "utf8"), "bar baz");
  });

  test("多处替换长度不同时偏移各自正确，顺序无关", async () => {
    put("e3.txt", "A-B-C");
    await runTool("edit", {
      path: "e3.txt",
      edits: [
        { oldText: "C", newText: "cccc" },
        { oldText: "A", newText: "" },
        { oldText: "B", newText: "bb" },
      ],
    });
    assert.equal(readFileSync(join(box.project, "e3.txt"), "utf8"), "-bb-cccc");
  });

  test("相邻不重叠的两处可以一起改", async () => {
    put("e4.txt", "abcdef");
    await runTool("edit", {
      path: "e4.txt",
      edits: [
        { oldText: "abc", newText: "1" },
        { oldText: "def", newText: "2" },
      ],
    });
    assert.equal(readFileSync(join(box.project, "e4.txt"), "utf8"), "12");
  });

  test("区间重叠报错，文件不动", async () => {
    put("e5.txt", "abcdef");
    await assert.rejects(
      runTool("edit", {
        path: "e5.txt",
        edits: [
          { oldText: "abc", newText: "x" },
          { oldText: "cde", newText: "y" },
        ],
      }),
      { message: "overlapping edits in e5.txt" },
    );
    assert.equal(readFileSync(join(box.project, "e5.txt"), "utf8"), "abcdef");
  });

  test("找不到 oldText 报错并带上片段", async () => {
    put("e6.txt", "abc");
    await assert.rejects(runTool("edit", { path: "e6.txt", edits: [{ oldText: "zzz", newText: "" }] }), {
      message: 'oldText not found in e6.txt: "zzz"',
    });
  });

  test("oldText 出现多次报错", async () => {
    put("e7.txt", "x x");
    await assert.rejects(runTool("edit", { path: "e7.txt", edits: [{ oldText: "x", newText: "y" }] }), {
      message: "oldText occurs more than once in e7.txt; it must be unique",
    });
  });

  test("后面一处失败时前面的也不落盘", async () => {
    put("e8.txt", "one two");
    await assert.rejects(
      runTool("edit", {
        path: "e8.txt",
        edits: [
          { oldText: "one", newText: "1" },
          { oldText: "three", newText: "3" },
        ],
      }),
    );
    assert.equal(readFileSync(join(box.project, "e8.txt"), "utf8"), "one two");
  });

  test("edits 为空或不是数组、字段不是字符串都报错", async () => {
    put("e9.txt", "abc");
    await assert.rejects(runTool("edit", { path: "e9.txt", edits: [] }), { message: "edits must be a non-empty array" });
    await assert.rejects(runTool("edit", { path: "e9.txt", edits: "abc" }), { message: "edits must be a non-empty array" });
    await assert.rejects(runTool("edit", { path: "e9.txt", edits: [{ oldText: "a", newText: 1 }] }), {
      message: "oldText and newText must be strings",
    });
  });

  test("文件不存在抛 ENOENT", async () => {
    await assert.rejects(runTool("edit", { path: "gone.txt", edits: [{ oldText: "a", newText: "b" }] }), { code: "ENOENT" });
  });
});

describe("bash", () => {
  test("stdout 与 stderr 合并返回", async () => {
    const out = await runTool("bash", { command: "echo out; echo err 1>&2" });
    assert.deepEqual(out.split("\n").sort(), ["err", "out"]);
  });

  test("末尾空白去掉", async () => {
    assert.equal(await runTool("bash", { command: "printf 'x\\n\\n\\n  '" }), "x");
  });

  test("在当前工作目录里跑", async () => {
    mkdirSync(join(box.project, "cwdcheck"), { recursive: true });
    assert.equal(await runTool("bash", { command: "pwd" }), box.project);
  });

  test("非零退出码写在结尾", async () => {
    assert.equal(await runTool("bash", { command: "echo bad; exit 3" }), "bad\n[exit code 3]");
  });

  test("没有输出时写 (no output)", async () => {
    assert.equal(await runTool("bash", { command: "true" }), "(no output)");
    assert.equal(await runTool("bash", { command: "exit 2" }), "(no output)\n[exit code 2]");
  });

  // 下面几条的 sleep 远长于测试超时：没被杀就不会自然结束，靠结果里的标记断言，超时只防卡死
  test("超时被杀并注明 timeout", { timeout: 20_000 }, async () => {
    const out = await runTool("bash", { command: "sleep 60", timeout: 0.3 });
    assert.equal(out, "(no output)\n[killed by SIGTERM (timeout)]");
  });

  test("复合命令超时，整条被杀，已有输出保留", { timeout: 20_000 }, async () => {
    const out = await runTool("bash", { command: "echo started; sleep 60", timeout: 0.3 });
    assert.equal(out, "started\n[killed by SIGTERM (timeout)]");
  });

  test("管道被打断，两端都被杀", { timeout: 20_000 }, async () => {
    const ac = new AbortController();
    const running = runTool("bash", { command: "sleep 60 | cat" }, ac.signal);
    ac.abort();
    assert.match(await running, /\[killed by SIGTERM \(interrupted\)\]$/);
  });

  test("打断后子进程确实不在了", { timeout: 20_000 }, async () => {
    const pidFile = join(box.project, "child.pid");
    const ac = new AbortController();
    // 后台起一个 sleep 记下 pid，再 wait 住，保证打断时它还在跑
    const running = runTool("bash", { command: `sleep 60 & echo $! > ${pidFile}; wait` }, ac.signal);
    while (!readFileSync(pidFile, { flag: "a+" }).toString().trim()) await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await running;
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    // SIGTERM 到达和进程回收之间有一点时间，最多等 2 秒
    let alive = true;
    for (let i = 0; i < 200 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 10));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false);
  });

  test("运行中 abort 被杀并注明 interrupted", { timeout: 20_000 }, async () => {
    const ac = new AbortController();
    // runTool 同步起进程并挂上监听，紧接着 abort 就是「跑起来之后被打断」
    const running = runTool("bash", { command: "sleep 60" }, ac.signal);
    ac.abort();
    assert.equal(await running, "(no output)\n[killed by SIGTERM (interrupted)]");
  });

  test("信号已打断时立刻被杀", { timeout: 20_000 }, async () => {
    const ac = new AbortController();
    ac.abort();
    const out = await runTool("bash", { command: "sleep 60" }, ac.signal);
    assert.match(out, /\[killed by SIGTERM \(interrupted\)\]$/);
  });

  test("输出超过 2000 行被截断", async () => {
    const out = await runTool("bash", { command: "seq 1 2500" });
    assert.ok(out.endsWith("\n... [truncated: showing 2000 of 2500 lines]"));
    assert.equal(out.split("\n")[1999], "2000");
  });
});

describe("truncate", () => {
  test("上限是 2000 行、50KB", () => {
    assert.equal(MAX_LINES, 2000);
    assert.equal(MAX_BYTES, 50 * 1024);
  });

  test("不超限原样返回", () => {
    const s = Array.from({ length: 2000 }, () => "x").join("\n");
    assert.equal(truncate(s), s);
    assert.equal(truncate(""), "");
  });

  test("超过 2000 行只留前 2000 行并注明总行数", () => {
    const s = Array.from({ length: 2001 }, (_, i) => String(i + 1)).join("\n");
    const out = truncate(s);
    assert.equal(out, Array.from({ length: 2000 }, (_, i) => String(i + 1)).join("\n") + "\n... [truncated: showing 2000 of 2001 lines]");
  });

  test("超过 50KB 按字节截并注明", () => {
    const out = truncate("a".repeat(60 * 1024));
    assert.equal(out, "a".repeat(50 * 1024) + "\n... [truncated: output exceeded 50KB]");
  });

  test("先按行截、再按字节截时只留字节那条注明", () => {
    const line = "b".repeat(100);
    const out = truncate(Array.from({ length: 3000 }, () => line).join("\n"));
    assert.ok(out.endsWith("\n... [truncated: output exceeded 50KB]"));
    assert.ok(!out.includes("showing 2000"));
    assert.equal(Buffer.byteLength(out.slice(0, out.lastIndexOf("\n... ["))), 50 * 1024);
  });

  test("多字节字符按字节截，结果不超过 50KB", () => {
    const out = truncate("中".repeat(20_000));
    const body = out.slice(0, out.lastIndexOf("\n... ["));
    assert.ok(Buffer.byteLength(body) <= 50 * 1024 + 3);
    assert.ok(body.startsWith("中中中"));
  });
});
