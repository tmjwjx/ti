// cli/tui.ts：经 openTui + 模拟 stdin 按键，检查提交、斜杠列表、续行、历史、编辑键、打断与底栏向导
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { isolate } from "./helpers.ts";

isolate();
const { openTui } = await import("../src/cli/tui.ts");
const { COMMANDS } = await import("../src/cli/repl.ts");
type Tui = ReturnType<typeof openTui>;

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";

type Harness = { tui: Tui; type(s: string): void; flushEsc(): void };

// 打开一个主屏，屏幕输出吞掉、setTimeout 换成假时钟；跑完 fn 后关掉并还原
async function withTui(fn: (t: Harness) => Promise<void> | void): Promise<void> {
  const write = process.stdout.write;
  // 主屏只写字符串；测试进程向 node --test 汇报结果写的是 Buffer，必须放行，否则结果会丢
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
    typeof chunk === "string" ? true : (write as Function).call(process.stdout, chunk, ...rest)) as typeof process.stdout.write;
  // 单独的 Esc 要等 40ms 拼键超时才交出；拨假时钟，不靠真实等待
  mock.timers.enable({ apis: ["setTimeout"] });
  const tui = openTui();
  try {
    await fn({
      tui,
      type: (s) => process.stdin.emit("data", s),
      flushEsc: () => mock.timers.tick(40),
    });
  } finally {
    tui.close();
    mock.timers.reset();
    process.stdout.write = write;
  }
}

// 给主屏挂上一组 /model 二级选项，第二项是当前
function withModelLookup(tui: Tui): void {
  const items = [
    { name: "/model alpha-1", label: "alpha-1", hint: "", current: false },
    { name: "/model beta-2", label: "beta-2", hint: "current", current: true },
  ];
  tui.setLookup((input) => {
    if (input !== "/model" && !input.startsWith("/model ")) return null;
    const q = input.slice(6).trim();
    return items.filter((it) => !q || it.label.includes(q));
  });
}

// 依次提交几行并把它们从队列里取走
async function submitAll(t: Harness, lines: string[]): Promise<void> {
  for (const l of lines) {
    t.type(`${l}\r`);
    assert.equal(await t.tui.readLine(), l);
  }
}

// 看一个 promise 眼下是否已经有结果
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(() => (done = true));
  await new Promise((r) => setImmediate(r));
  return done;
}

describe("提交", () => {
  test("Enter 把整行交给 readLine", () =>
    withTui(async ({ tui, type }) => {
      const line = tui.readLine();
      type("hello 世界\r");
      assert.equal(await line, "hello 世界");
    }));

  test("没人等时 Enter 进队列，之后按顺序取", () =>
    withTui(async ({ tui, type }) => {
      type("one\rtwo\r");
      assert.equal(await tui.readLine(), "one");
      assert.equal(await tui.readLine(), "two");
    }));

  test("空行也会提交", () =>
    withTui(async ({ tui, type }) => {
      type("\r");
      assert.equal(await tui.readLine(), "");
    }));
});

describe("斜杠列表", () => {
  test("命令带参数时回车提交整行", () =>
    withTui(async ({ tui, type }) => {
      tui.setCommands(COMMANDS);
      type("/rename foo bar\r");
      assert.equal(await tui.readLine(), "/rename foo bar");
    }));

  test("只打了前缀时回车提交高亮的那条命令", () =>
    withTui(async ({ tui, type }) => {
      tui.setCommands(COMMANDS);
      type("/ren\r");
      assert.equal(await tui.readLine(), "/rename");
      // /re 同时匹配 /resume 与 /rename，默认高亮第一条
      type("/re\r");
      assert.equal(await tui.readLine(), "/resume");
      type(`/re${DOWN}\r`);
      assert.equal(await tui.readLine(), "/rename");
      type(`/re${UP}\r`);
      assert.equal(await tui.readLine(), "/rename");
    }));

  test("没有匹配的命令时照原样提交", () =>
    withTui(async ({ tui, type }) => {
      tui.setCommands(COMMANDS);
      type("/zzz\r");
      assert.equal(await tui.readLine(), "/zzz");
    }));

  test("没设命令列表时 / 开头也照原样提交", () =>
    withTui(async ({ tui, type }) => {
      type("/ren\r");
      assert.equal(await tui.readLine(), "/ren");
    }));

  test("/mo 回车先展开成 /model 二级，不提交；再回车提交当前那项", () =>
    withTui(async ({ tui, type }) => {
      tui.setCommands(COMMANDS);
      withModelLookup(tui);
      const line = tui.readLine();
      type("/mo\r");
      assert.equal(await settled(line), false);
      type("\r");
      assert.equal(await line, "/model beta-2");
    }));

  test("二级列表里 ↓ 换一项再回车", () =>
    withTui(async ({ tui, type }) => {
      tui.setCommands(COMMANDS);
      withModelLookup(tui);
      type(`/mo\r${DOWN}\r`);
      assert.equal(await tui.readLine(), "/model alpha-1");
    }));

  test("二级带过滤词时回车提交过滤后的那项", () =>
    withTui(async ({ tui, type }) => {
      tui.setCommands(COMMANDS);
      withModelLookup(tui);
      type("/model alp\r");
      assert.equal(await tui.readLine(), "/model alpha-1");
    }));

  test("Tab 补全命令名，之后可接着打参数", () =>
    withTui(async ({ tui, type }) => {
      tui.setCommands(COMMANDS);
      type("/cl\t x\r");
      assert.equal(await tui.readLine(), "/clear x");
    }));

  test("Tab 在有二级的命令上展开成 `/model `", () =>
    withTui(async ({ tui, type }) => {
      tui.setCommands(COMMANDS);
      withModelLookup(tui);
      type("/mo\t\r");
      assert.equal(await tui.readLine(), "/model beta-2");
    }));

  test("Esc 在二级里先退回 /model，列表回到全部选项", () =>
    withTui(async ({ tui, type, flushEsc }) => {
      tui.setCommands(COMMANDS);
      withModelLookup(tui);
      type("/model beta");
      type("\x1b");
      flushEsc();
      type("\r");
      assert.equal(await tui.readLine(), "/model alpha-1");
    }));

  test("Esc 在一级列表里退回 /", () =>
    withTui(async ({ tui, type, flushEsc }) => {
      tui.setCommands(COMMANDS);
      type("/ren");
      type("\x1b");
      flushEsc();
      type("\r");
      assert.equal(await tui.readLine(), COMMANDS[0]!.name);
    }));

  test("多行输入不弹列表", () =>
    withTui(async ({ tui, type }) => {
      tui.setCommands(COMMANDS);
      type("/re\x1b\rmore\r");
      assert.equal(await tui.readLine(), "/re\nmore");
    }));
});

describe("多行", () => {
  test("光标前是 \\ 时回车换成换行，不提交", () =>
    withTui(async ({ tui, type }) => {
      const line = tui.readLine();
      type("a\\\r");
      assert.equal(await settled(line), false);
      type("b\r");
      assert.equal(await line, "a\nb");
    }));

  test("\\ 后面还有字符时照常提交", () =>
    withTui(async ({ tui, type }) => {
      type("a\\ \r");
      assert.equal(await tui.readLine(), "a\\ ");
    }));

  test("Shift+Enter（ESC CR 与 kitty 写法）插入换行", () =>
    withTui(async ({ tui, type }) => {
      type("a\x1b\rb\x1b[13;2uc\r");
      assert.equal(await tui.readLine(), "a\nb\nc");
    }));
});

describe("↑↓ 历史", () => {
  test("↑ 翻上一条，到最早停住；↓ 越过最新回到草稿", () =>
    withTui(async (t) => {
      await submitAll(t, ["one", "two"]);
      t.type(`draft${UP}\r`);
      assert.equal(await t.tui.readLine(), "two");
      t.type(`x${UP}${UP}${UP}\r`);
      assert.equal(await t.tui.readLine(), "one");
      t.type(`draft2${UP}${UP}${DOWN}${DOWN}\r`);
      assert.equal(await t.tui.readLine(), "draft2");
    }));

  test("没有历史时 ↑ 不改输入", () =>
    withTui(async ({ tui, type }) => {
      type(`keep${UP}\r`);
      assert.equal(await tui.readLine(), "keep");
    }));

  test("记历史时先 trim，连续相同只留一条，空白行不记", () =>
    withTui(async (t) => {
      t.type("  a  \r");
      assert.equal(await t.tui.readLine(), "  a  ");
      await submitAll(t, ["a", "b", "b", "   "]);
      t.type(`${UP}${UP}\r`);
      assert.equal(await t.tui.readLine(), "a");
    }));

  test("addHistory 灌入的行同样去重和 trim，并回到草稿位置", () =>
    withTui(async ({ tui, type }) => {
      tui.addHistory(["p", "q", "q", " r "]);
      type(`${UP}\r`);
      assert.equal(await tui.readLine(), "r");
      tui.addHistory(["s"]);
      type(`${UP}${UP}${UP}${UP}\r`);
      assert.equal(await tui.readLine(), "p");
    }));

  test("多行输入里 ↑ 先在行间移动，到顶才翻历史", () =>
    withTui(async (t) => {
      await submitAll(t, ["old"]);
      t.type(`l1\x1b\rl2${UP}X\r`);
      assert.equal(await t.tui.readLine(), "l1X\nl2");
    }));
});

describe("编辑键", () => {
  const cases: [string, string, string][] = [
    ["Ctrl+U 删到行首", "hello world\x15x", "x"],
    ["Ctrl+A 再 Ctrl+K 删到行尾", "hello\x01\x0bz", "z"],
    ["Ctrl+A 回行首插入", "world\x01hello ", "hello world"],
    ["Ctrl+E 回行尾", "abc\x01\x05!", "abc!"],
    ["← 再 Backspace", `abc${LEFT}\x7f`, "ac"],
    ["Ctrl+H 删前一字", "abc\x08", "ab"],
    ["Delete 删后一字", "abc\x01\x1b[3~", "bc"],
    ["Ctrl+B、Ctrl+F 左右移", "ac\x02b\x06d", "abcd"],
    ["Ctrl+← 按词左跳", "foo bar\x1b[1;5DX", "foo Xbar"],
    ["Ctrl+→ 按词右跳", "foo bar\x01\x1b[1;5CX", "fooX bar"],
    ["Home、End", "mid\x1b[Ha\x1b[Fz", "amidz"],
    ["有字时 Ctrl+C 清空", "abc\x03d", "d"],
    ["emoji 按码点删", `😀x${LEFT}\x7f`, "x"],
    ["Ctrl+U 只删当前逻辑行", "ab\x1b\rcd\x15x", "ab\nx"],
    ["Ctrl+K 只删到当前行尾", "ab\x1b\rcd\x1b[A\x01\x0b", "\ncd"],
    ["行首 Backspace 什么都不做", "\x7fok", "ok"],
  ];
  for (const [name, keys, want] of cases) {
    test(name, () =>
      withTui(async ({ tui, type }) => {
        type(`${keys}\r`);
        assert.equal(await tui.readLine(), want);
      }));
  }

  test("有字时 Esc 清空", () =>
    withTui(async ({ tui, type, flushEsc }) => {
      type("abc\x1b");
      flushEsc();
      type("d\r");
      assert.equal(await tui.readLine(), "d");
    }));
});

describe("退出与打断", () => {
  test("空闲时空输入 Ctrl+C 退出，挂着的 readLine 得到 null", () =>
    withTui(async ({ tui, type }) => {
      const line = tui.readLine();
      type("\x03");
      assert.equal(await line, null);
      assert.equal(await tui.readLine(), null);
    }));

  test("忙时空输入 Ctrl+C 走打断回调，不退出", () =>
    withTui(async ({ tui, type }) => {
      let hits = 0;
      tui.onInterrupt(() => (hits += 1));
      tui.setBusy(true);
      type("\x03");
      assert.equal(hits, 1);
      type("still here\r");
      assert.equal(await tui.readLine(), "still here");
    }));

  test("忙时 Esc 走打断回调", () =>
    withTui(async ({ tui, type, flushEsc }) => {
      let hits = 0;
      tui.onInterrupt(() => (hits += 1));
      tui.setBusy(true);
      type("\x1b");
      flushEsc();
      assert.equal(hits, 1);
    }));

  test("忙时有字的 Ctrl+C 只清空，不打断", () =>
    withTui(async ({ tui, type }) => {
      let hits = 0;
      tui.onInterrupt(() => (hits += 1));
      tui.setBusy(true);
      type("abc\x03");
      assert.equal(hits, 0);
    }));

  test("close 解开所有挂着的 readLine", () =>
    withTui(async ({ tui }) => {
      const a = tui.readLine();
      const b = tui.readLine();
      tui.close();
      assert.deepEqual(await Promise.all([a, b]), [null, null]);
    }));

  test("close 之后按键不再有反应", () =>
    withTui(async ({ tui, type }) => {
      tui.close();
      type("x\r");
      assert.equal(await tui.readLine(), null);
    }));
});

describe("底栏向导", () => {
  const choices = [
    { value: 1, label: "one" },
    { value: 2, label: "two" },
    { value: 3, label: "three" },
  ];

  test("pick：从 initial 起，↑↓ 循环，回车交回值；打字不进框", () =>
    withTui(async ({ tui, type }) => {
      const first = tui.pick("Pick", choices, 1);
      type(`abc${DOWN}\r`);
      assert.equal(await first, 3);
      const second = tui.pick("Pick", choices, 0);
      type(`${UP}\r`);
      assert.equal(await second, 3);
      // 向导结束后框是空的，打的字没留下
      type("\r");
      assert.equal(await tui.readLine(), "");
    }));

  test("pick：Esc 与 Ctrl+C 取消得到 undefined；空列表直接 undefined", () =>
    withTui(async ({ tui, type, flushEsc }) => {
      const a = tui.pick("Pick", choices);
      type("\x1b");
      flushEsc();
      assert.equal(await a, undefined);
      const b = tui.pick("Pick", choices);
      type("\x03");
      assert.equal(await b, undefined);
      assert.equal(await tui.pick("Empty", []), undefined);
    }));

  test("ask：回车交回输入；斜杠不弹命令列表", () =>
    withTui(async ({ tui, type }) => {
      tui.setCommands(COMMANDS);
      const key = tui.ask("API key", { secret: true });
      type("/cl\r");
      assert.equal(await key, "/cl");
    }));

  test("ask：Esc 取消得到 undefined", () =>
    withTui(async ({ tui, type, flushEsc }) => {
      const a = tui.ask("Name");
      type("partial\x1b");
      flushEsc();
      assert.equal(await a, undefined);
    }));

  test("close 时挂着的向导当取消", () =>
    withTui(async ({ tui }) => {
      const p = tui.pick("Pick", choices);
      tui.close();
      assert.equal(await p, undefined);
    }));
});

describe("pause 与 resume", () => {
  test("pause 期间按键不进框，resume 后恢复", () =>
    withTui(async ({ tui, type }) => {
      tui.pause();
      type("lost\r");
      tui.resume();
      type("kept\r");
      assert.equal(await tui.readLine(), "kept");
    }));
});

test("写对话区与底栏的调用不影响输入", () =>
  withTui(async ({ tui, type }) => {
    tui.write("stream ");
    tui.write("tokens\npartial");
    tui.writeln("line");
    tui.setFooter("footer");
    tui.clear();
    type("ok\r");
    assert.equal(await tui.readLine(), "ok");
  }));
