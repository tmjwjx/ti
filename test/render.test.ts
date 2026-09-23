// cli/render.ts：AgentUI 的屏幕文字与 replayMessages 按历史重画
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "../src/types.ts";
import { isolate, plain } from "./helpers.ts";

isolate();
const { createTerminalUI, replayMessages } = await import("../src/cli/render.ts");

// 一个把 write 与 writeln 分别记下的假输出，all() 按屏幕顺序拼回去
function screen() {
  const calls: { kind: "write" | "writeln"; text: string }[] = [];
  const out = {
    write: (s: string) => calls.push({ kind: "write", text: plain(s) }),
    writeln: (s: string) => calls.push({ kind: "writeln", text: plain(s) }),
  };
  const lines = () => calls.filter((c) => c.kind === "writeln").map((c) => c.text);
  const all = () => calls.map((c) => (c.kind === "writeln" ? c.text + "\n" : c.text)).join("");
  return { out, lines, all };
}

describe("createTerminalUI", () => {
  test("text 不换行直接写；info、error 各占一行", () => {
    const s = screen();
    const ui = createTerminalUI(s.out);
    ui.text("流");
    ui.text("式");
    ui.info("  10 in · 2 out");
    ui.error("boom");
    assert.equal(s.all(), "流式  10 in · 2 out\nboom\n");
  });

  test("工具调用一行摘要：read 带行号范围，write 只印字节数，edit 印条数，bash 压成一行", () => {
    const s = screen();
    const ui = createTerminalUI(s.out);
    ui.toolCall({ type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts", offset: 10, limit: 5 } });
    ui.toolCall({ type: "toolCall", id: "2", name: "write", arguments: { path: "b.ts", content: "中文" } });
    ui.toolCall({ type: "toolCall", id: "3", name: "edit", arguments: { path: "c.ts", edits: [{}, {}] } });
    ui.toolCall({ type: "toolCall", id: "4", name: "bash", arguments: { command: "echo  a\n  && ls" } });
    ui.toolCall({ type: "toolCall", id: "5", name: "custom", arguments: { k: 1 } });
    assert.deepEqual(s.lines(), [
      "  → read  a.ts:10,5",
      "  → write  b.ts (6 bytes)",
      "  → edit  c.ts (2 edit(s))",
      "  → bash  echo a && ls",
      '  → custom  {"k":1}',
    ]);
  });

  test("bash 摘要截到 120 字", () => {
    const s = screen();
    createTerminalUI(s.out).toolCall({ type: "toolCall", id: "1", name: "bash", arguments: { command: "x".repeat(300) } });
    assert.equal(s.lines()[0], `  → bash  ${"x".repeat(120)}`);
  });

  test("结果只预览 5 行并注明还剩几行", () => {
    const s = screen();
    createTerminalUI(s.out).result("1\n2\n3\n4\n5\n6\n7", false);
    assert.deepEqual(s.lines(), ["    1\n    2\n    3\n    4\n    5\n    … (2 more lines)"]);
  });

  test("结果不超过 5 行时全部缩进印出", () => {
    const s = screen();
    createTerminalUI(s.out).result("only\ntwo", true);
    assert.deepEqual(s.lines(), ["    only\n    two"]);
  });
});

describe("replayMessages", () => {
  test("user 画成 ❯ 开头，多行后续缩进，前面空一行", () => {
    const s = screen();
    replayMessages([{ role: "user", content: "first\nsecond" }], s.out);
    assert.deepEqual(s.lines(), ["", "❯ first", "  second"]);
  });

  test("块数组的 user 拼成文本", () => {
    const s = screen();
    replayMessages([{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }], s.out);
    assert.deepEqual(s.lines(), ["", "❯ ab"]);
  });

  test("超长 user 截到 4000 字", () => {
    const s = screen();
    replayMessages([{ role: "user", content: "u".repeat(5000) }], s.out);
    assert.deepEqual(s.lines(), ["", `❯ ${"u".repeat(4000)}`, "  … (truncated)"]);
  });

  test("summary 只画一行 [compacted summary]", () => {
    const s = screen();
    replayMessages([{ role: "summary", text: "long secret summary", files: { read: ["a"], modified: [] } }], s.out);
    assert.deepEqual(s.lines(), ["[compacted summary]"]);
    assert.ok(!s.all().includes("secret"));
  });

  test("skill 画成用户打的 /名字 参数，不铺全文", () => {
    const s = screen();
    replayMessages(
      [
        { role: "skill", name: "review", path: "/p/SKILL.md", body: "BODY TEXT", args: "src" },
        { role: "skill", name: "lint", path: "/p/SKILL.md", body: "BODY TEXT", args: "" },
      ],
      s.out,
    );
    assert.deepEqual(s.lines(), ["", "❯ /review src", "", "❯ /lint"]);
    assert.ok(!s.all().includes("BODY TEXT"));
  });

  test("assistant：文字流出后换行，再画工具调用，工具结果缩进", () => {
    const s = screen();
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me look" },
          { type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } },
        ],
        stopReason: "toolUse",
        usage: { input: 5, output: 5 },
      },
      { role: "toolResult", toolCallId: "c", toolName: "bash", content: "a.txt", isError: false },
    ];
    replayMessages(msgs, s.out);
    assert.equal(s.all(), "let me look\n  → bash  ls\n    a.txt\n");
  });

  test("被打断的 assistant：先画文字再 [interrupted]，不画半截调用", () => {
    const s = screen();
    replayMessages(
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "half" },
            { type: "toolCall", id: "c", name: "bash", arguments: { command: "rm -rf x" } },
          ],
          stopReason: "aborted",
          usage: { input: 0, output: 0 },
        },
      ],
      s.out,
    );
    assert.equal(s.all(), "half\n[interrupted]\n");
    assert.ok(!s.all().includes("→"));
  });

  test("空的被打断 assistant 只画 [interrupted]", () => {
    const s = screen();
    replayMessages([{ role: "assistant", content: [], stopReason: "aborted", usage: { input: 0, output: 0 } }], s.out);
    assert.equal(s.all(), "[interrupted]\n");
  });

  test("不画 token 行", () => {
    const s = screen();
    replayMessages([{ role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "stop", usage: { input: 999, output: 9 } }], s.out);
    assert.equal(s.all(), "x\n");
  });
});
