// cli/keys.ts：原始字节收成规范按键名、可输入字符判断、转义序列拼装与超时
import { test, describe, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createKeyAssembler, isCharKey, parseKey } from "../src/cli/keys.ts";

// 逐条检查 [原始字节, 期望名字]
function expectKeys(cases: [string, string][]): void {
  for (const [raw, name] of cases) assert.equal(parseKey(raw), name, JSON.stringify(raw));
}

describe("parseKey", () => {
  test("整段命名序列", () => {
    expectKeys([
      ["\x1b", "esc"],
      ["\r", "enter"],
      ["\n", "enter"],
      ["\t", "tab"],
      ["\x7f", "backspace"],
      ["\x08", "backspace"],
      ["\x1b[Z", "shift+tab"],
      ["\x1b\r", "shift+enter"],
      ["\x1b\n", "shift+enter"],
      ["\x1b[3~", "delete"],
      ["\x1b[5~", "page-up"],
      ["\x1b[6~", "page-down"],
    ]);
  });

  test("方向与 Home、End 的 CSI 和 SS3 两种写法", () => {
    expectKeys([
      ["\x1b[A", "up"],
      ["\x1bOA", "up"],
      ["\x1b[B", "down"],
      ["\x1bOB", "down"],
      ["\x1b[C", "right"],
      ["\x1bOC", "right"],
      ["\x1b[D", "left"],
      ["\x1bOD", "left"],
      ["\x1b[H", "home"],
      ["\x1bOH", "home"],
      ["\x1b[1~", "home"],
      ["\x1b[7~", "home"],
      ["\x1b[F", "end"],
      ["\x1bOF", "end"],
      ["\x1b[4~", "end"],
      ["\x1b[8~", "end"],
    ]);
  });

  test("带修饰的 CSI：字母结尾与 ~ 结尾", () => {
    expectKeys([
      ["\x1b[1;5C", "ctrl+right"],
      ["\x1b[1;5D", "ctrl+left"],
      ["\x1b[1;3D", "alt+left"],
      ["\x1b[1;2A", "shift+up"],
      ["\x1b[1;6B", "ctrl+shift+down"],
      ["\x1b[1;8H", "ctrl+alt+shift+home"],
      ["\x1b[3;2~", "shift+delete"],
      ["\x1b[5;5~", "ctrl+page-up"],
      ["\x1b[1;1C", "right"],
    ]);
  });

  test("kitty CSI u：字母、功能键、修饰、附加字段", () => {
    expectKeys([
      ["\x1b[97u", "a"],
      ["\x1b[97;5u", "ctrl+a"],
      ["\x1b[65;2u", "shift+a"],
      ["\x1b[13u", "enter"],
      ["\x1b[13;2u", "shift+enter"],
      ["\x1b[13;5u", "ctrl+enter"],
      ["\x1b[27u", "esc"],
      ["\x1b[9;2u", "shift+tab"],
      ["\x1b[127;3u", "alt+backspace"],
      ["\x1b[57414u", "enter"],
      ["\x1b[57419;5u", "ctrl+up"],
      ["\x1b[57426u", "delete"],
      ["\x1b[32;5u", "ctrl+ "],
      ["\x1b[49;3u", "alt+1"],
      ["\x1b[97:65;6u", "ctrl+shift+a"],
      ["\x1b[99;5:1u", "ctrl+c"],
    ]);
  });

  test("kitty 里认不出的码点原样返回", () => {
    assert.equal(parseKey("\x1b[200u"), "\x1b[200u");
  });

  test("modifyOtherKeys：ESC [ 27 ; 修饰 ; 码点 ~", () => {
    expectKeys([
      ["\x1b[27;5;97~", "ctrl+a"],
      ["\x1b[27;2;13~", "shift+enter"],
      ["\x1b[27;3;120~", "alt+x"],
    ]);
  });

  test("单字节 Ctrl+字母", () => {
    expectKeys([
      ["\x01", "ctrl+a"],
      ["\x03", "ctrl+c"],
      ["\x05", "ctrl+e"],
      ["\x0b", "ctrl+k"],
      ["\x15", "ctrl+u"],
      ["\x1a", "ctrl+z"],
    ]);
  });

  test("普通字符与认不出的序列原样返回", () => {
    expectKeys([
      ["a", "a"],
      ["Z", "Z"],
      [" ", " "],
      ["中", "中"],
      ["😀", "😀"],
      ["\x1b[2~", "\x1b[2~"],
      ["\x1b[99X", "\x1b[99X"],
      ["\x00", "\x00"],
    ]);
  });
});

describe("isCharKey", () => {
  test("单个可见码点才算，包括中文和 emoji", () => {
    for (const k of ["a", " ", "~", "中", "😀"]) assert.equal(isCharKey(k), true, k);
  });

  test("命名键、控制字符、多个字符、空串都不算", () => {
    for (const k of ["enter", "ctrl+a", "up", "\x01", "\x1b", "ab", ""]) assert.equal(isCharKey(k), false, JSON.stringify(k));
  });
});

describe("createKeyAssembler", () => {
  afterEach(() => mock.timers.reset());

  // 建一个拼装器并收集它交出的序列
  function assembler() {
    const out: string[] = [];
    const keys = createKeyAssembler((s) => out.push(s));
    const push = (s: string) => {
      for (const ch of s) keys.push(ch);
    };
    return { out, keys, push };
  }

  test("普通字符立刻交出", () => {
    const { out, push } = assembler();
    push("ab中");
    assert.deepEqual(out, ["a", "b", "中"]);
  });

  test("逐字到达的 CSI 收齐后整段交出一次", () => {
    const { out, push } = assembler();
    push("\x1b[A");
    push("\x1b[1;5C");
    push("\x1b[97;5u");
    assert.deepEqual(out, ["\x1b[A", "\x1b[1;5C", "\x1b[97;5u"]);
  });

  test("SS3 与 ESC+字节两字节就收齐", () => {
    const { out, push } = assembler();
    push("\x1bOA");
    push("\x1b\r");
    assert.deepEqual(out, ["\x1bOA", "\x1b\r"]);
  });

  test("单独一个 ESC 等 40ms 后当 esc 交出", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { out, push } = assembler();
    push("\x1b");
    mock.timers.tick(39);
    assert.deepEqual(out, []);
    mock.timers.tick(1);
    assert.deepEqual(out, ["\x1b"]);
  });

  test("半截 CSI 超时丢掉、不重放，之后的键照常", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { out, push } = assembler();
    push("\x1b[1;");
    mock.timers.tick(40);
    assert.deepEqual(out, []);
    push("x");
    assert.deepEqual(out, ["x"]);
  });

  test("序列中间每来一字就重新计时", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { out, push } = assembler();
    push("\x1b");
    mock.timers.tick(30);
    push("[");
    mock.timers.tick(30);
    push("B");
    assert.deepEqual(out, ["\x1b[B"]);
    mock.timers.tick(100);
    assert.deepEqual(out, ["\x1b[B"]);
  });

  test("reset 丢掉半截并取消计时", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { out, keys, push } = assembler();
    push("\x1b[");
    keys.reset();
    mock.timers.tick(100);
    push("q");
    assert.deepEqual(out, ["q"]);
  });

  test("拼出的序列与 parseKey 对得上", () => {
    const { out, push } = assembler();
    push("\x1b[3~\x1b[Z\x1b[57419;5u");
    assert.deepEqual(out.map(parseKey), ["delete", "shift+tab", "ctrl+up"]);
  });
});
