// core/skills.ts：skill 发现与优先级、frontmatter 解析、提示词清单与读全文
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolate } from "./helpers.ts";

const box = isolate();
const { loadSkills, readSkillBody, skillsPrompt } = await import("../src/core/skills.ts");

const projectRoot = join(box.project, ".ti", "skills");
const userRoot = join(box.home, ".ti", "skills");

// 在指定 skills 根目录下建一个 skill 目录，写入原样的 SKILL.md 文本
function putSkill(root: string, dir: string, text: string): string {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  const path = join(d, "SKILL.md");
  writeFileSync(path, text);
  return path;
}

// 用给定的 frontmatter 行和正文拼出 SKILL.md 文本
function md(head: string, body = "Do the thing."): string {
  return `---\n${head}\n---\n${body}\n`;
}

// 只放一个项目级 skill，返回解析出的 description
function descOf(head: string): string | undefined {
  putSkill(projectRoot, "probe", md(head));
  return loadSkills([]).skills.find((s) => s.name === "probe")?.description;
}

beforeEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(userRoot, { recursive: true, force: true });
});

describe("loadSkills 扫描与优先级", () => {
  test("两处目录都不存在时返回空列表且无警告", () => {
    assert.deepEqual(loadSkills([]), { skills: [], warnings: [] });
  });

  test("项目级与用户级各自加载，source 标对", () => {
    putSkill(projectRoot, "alpha", md("description: project one"));
    putSkill(userRoot, "beta", md("description: user one"));
    const { skills, warnings } = loadSkills([]);
    assert.deepEqual(warnings, []);
    assert.deepEqual(
      skills.map((s) => [s.name, s.source, s.description]),
      [
        ["alpha", "project", "project one"],
        ["beta", "user", "user one"],
      ],
    );
    const alpha = skills[0]!;
    assert.equal(alpha.path, join(projectRoot, "alpha", "SKILL.md"));
    assert.equal(alpha.dir, join(projectRoot, "alpha"));
    assert.equal(alpha.hidden, false);
    assert.equal(alpha.listed, true);
    assert.equal(alpha.invocable, true);
  });

  test("同名时项目级胜出，用户级那份给出遮蔽警告", () => {
    putSkill(projectRoot, "dup", md("description: from project"));
    putSkill(userRoot, "dup", md("description: from user"));
    const { skills, warnings } = loadSkills([]);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.source, "project");
    assert.equal(skills[0]!.description, "from project");
    assert.deepEqual(warnings, ['name "dup" in ~/.ti/skills is shadowed by .ti/skills']);
  });

  test("按 frontmatter 的 name 判重名，而不是目录名", () => {
    putSkill(projectRoot, "dir-a", md("name: same\ndescription: a"));
    putSkill(projectRoot, "dir-b", md("name: same\ndescription: b"));
    const { skills, warnings } = loadSkills([]);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.description, "a");
    assert.deepEqual(warnings, ['name "same" in .ti/skills is shadowed by .ti/skills']);
  });

  test("用户目录里指向项目 skill 的符号链接按真实路径去重，不报遮蔽", () => {
    putSkill(projectRoot, "linked", md("description: real"));
    mkdirSync(userRoot, { recursive: true });
    symlinkSync(join(projectRoot, "linked"), join(userRoot, "linked"));
    const { skills, warnings } = loadSkills([]);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.source, "project");
    assert.deepEqual(warnings, []);
  });

  test("整个 ~/.ti/skills 链到项目 skills 目录时全部去重", () => {
    putSkill(projectRoot, "one", md("description: 1"));
    putSkill(projectRoot, "two", md("description: 2"));
    mkdirSync(join(box.home, ".ti"), { recursive: true });
    symlinkSync(projectRoot, userRoot);
    const { skills, warnings } = loadSkills([]);
    assert.deepEqual(skills.map((s) => s.name), ["one", "two"]);
    assert.deepEqual(warnings, []);
  });

  test("跳过点开头目录、node_modules、普通文件和没有 SKILL.md 的目录", () => {
    putSkill(projectRoot, ".hidden", md("description: dot"));
    putSkill(projectRoot, "node_modules", md("description: nm"));
    mkdirSync(join(projectRoot, "empty-dir"), { recursive: true });
    writeFileSync(join(projectRoot, "loose-file"), md("description: file"));
    putSkill(projectRoot, "ok", md("description: fine"));
    const { skills, warnings } = loadSkills([]);
    assert.deepEqual(skills.map((s) => s.name), ["ok"]);
    assert.deepEqual(warnings, []);
  });

  test("同一目录内按目录名排序", () => {
    putSkill(projectRoot, "zeta", md("description: z"));
    putSkill(projectRoot, "alpha", md("description: a"));
    putSkill(projectRoot, "mid", md("description: m"));
    assert.deepEqual(loadSkills([]).skills.map((s) => s.name), ["alpha", "mid", "zeta"]);
  });

  test("没写 name 时用目录名", () => {
    putSkill(projectRoot, "from-dir", md("description: d"));
    assert.equal(loadSkills([]).skills[0]!.name, "from-dir");
  });
});

describe("loadSkills 校验与警告", () => {
  test("与内置命令同名的 skill 不可调用并给警告", () => {
    putSkill(projectRoot, "help", md("description: clash"));
    const { skills, warnings } = loadSkills(["help", "exit"]);
    assert.equal(skills[0]!.invocable, false);
    assert.equal(skills[0]!.listed, true);
    assert.deepEqual(warnings, ['skill "help" is shadowed by the /help command']);
  });

  test("名字带空白：命名警告 + 不可调用警告", () => {
    const path = putSkill(projectRoot, "spaced", md('name: "my skill"\ndescription: d'));
    const { skills, warnings } = loadSkills([]);
    assert.equal(skills[0]!.name, "my skill");
    assert.equal(skills[0]!.invocable, false);
    assert.deepEqual(warnings, [
      `${path}: name "my skill" should be lowercase letters, digits and hyphens, at most 64`,
      'skill "my skill" has whitespace in its name and cannot be run as a command',
    ]);
  });

  test("名字不合规只警告，仍然加载并可调用", () => {
    const path = putSkill(projectRoot, "bad", md("name: Bad_Name\ndescription: d"));
    const { skills, warnings } = loadSkills([]);
    assert.equal(skills[0]!.name, "Bad_Name");
    assert.equal(skills[0]!.invocable, true);
    assert.deepEqual(warnings, [`${path}: name "Bad_Name" should be lowercase letters, digits and hyphens, at most 64`]);
  });

  test("名字超过 64 字符给命名警告", () => {
    const long = "a".repeat(65);
    const path = putSkill(projectRoot, "long", md(`name: ${long}\ndescription: d`));
    assert.deepEqual(loadSkills([]).warnings, [
      `${path}: name "${long}" should be lowercase letters, digits and hyphens, at most 64`,
    ]);
  });

  test("disable-model-invocation: true 隐藏且不进清单，但仍可调用", () => {
    putSkill(projectRoot, "secret", md("description: d\ndisable-model-invocation: true"));
    putSkill(projectRoot, "shown", md("description: d\ndisable-model-invocation: false"));
    const set = loadSkills([]);
    const secret = set.skills.find((s) => s.name === "secret")!;
    const shown = set.skills.find((s) => s.name === "shown")!;
    assert.equal(secret.hidden, true);
    assert.equal(secret.listed, false);
    assert.equal(secret.invocable, true);
    assert.equal(shown.hidden, false);
    assert.equal(shown.listed, true);
    assert.ok(!skillsPrompt(set).includes("<name>secret</name>"));
    assert.ok(skillsPrompt(set).includes("<name>shown</name>"));
  });

  test("缺 description 跳过并警告", () => {
    const path = putSkill(projectRoot, "nodesc", md("name: nodesc"));
    const { skills, warnings } = loadSkills([]);
    assert.deepEqual(skills, []);
    assert.deepEqual(warnings, [`${path}: description is required`]);
  });

  test("description 只有空白也算缺失", () => {
    const path = putSkill(projectRoot, "blank", md('description: "   "'));
    assert.deepEqual(loadSkills([]).warnings, [`${path}: description is required`]);
  });

  test("没有 frontmatter 的 SKILL.md 按缺 description 处理", () => {
    const path = putSkill(projectRoot, "raw", "# Just markdown\n\nbody\n");
    const { skills, warnings } = loadSkills([]);
    assert.deepEqual(skills, []);
    assert.deepEqual(warnings, [`${path}: description is required`]);
  });

  test("frontmatter 没有收尾 --- 按缺 description 处理", () => {
    const path = putSkill(projectRoot, "open", "---\ndescription: d\nbody\n");
    assert.deepEqual(loadSkills([]).warnings, [`${path}: description is required`]);
  });

  test("description 超过 1024 截断并警告", () => {
    const long = "x".repeat(1500);
    const path = putSkill(projectRoot, "wordy", md(`description: ${long}`));
    const { skills, warnings } = loadSkills([]);
    assert.equal(skills[0]!.description.length, 1024);
    assert.deepEqual(warnings, [`${path}: description is longer than 1024 characters, truncated`]);
  });

  test("清单超过 20000 字符后的 skill 不列出但可调用，并给一条汇总警告", () => {
    const desc = "d".repeat(1000);
    for (let i = 0; i < 25; i++) putSkill(projectRoot, `s-${String(i).padStart(2, "0")}`, md(`description: ${desc}`));
    const { skills, warnings } = loadSkills([]);
    const listed = skills.filter((s) => s.listed);
    const dropped = skills.filter((s) => !s.listed);
    assert.ok(listed.length > 0 && dropped.length > 0);
    // 按顺序放，先放满的是前面那些
    assert.deepEqual(skills.slice(0, listed.length), listed);
    assert.ok(dropped.every((s) => s.invocable));
    assert.deepEqual(warnings, [`skills catalog is full, ${dropped.length} skills not listed`]);
    const prompt = skillsPrompt({ skills, warnings });
    assert.ok(prompt.length <= 20_000 + 100);
    assert.ok(!prompt.includes(`<name>${dropped[0]!.name}</name>`));
  });

  test("只超出一个时警告用单数", () => {
    const desc = "d".repeat(1000);
    // 从只有一项的清单反推说明长度和单项长度，再凑到刚好多出一个
    putSkill(projectRoot, "s-00", md(`description: ${desc}`));
    const one = skillsPrompt(loadSkills([]));
    const head = one.indexOf("<available_skills>") - 4;
    const entry = one.length - (head + 4) - "<available_skills>\n".length - "\n</available_skills>".length;
    const fit = Math.floor((20_000 - head) / (entry + 1));
    for (let i = 1; i <= fit; i++) putSkill(projectRoot, `s-${String(i).padStart(2, "0")}`, md(`description: ${desc}`));
    const { warnings } = loadSkills([]);
    assert.deepEqual(warnings, ["skills catalog is full, 1 skill not listed"]);
  });

  test("隐藏的 skill 不占清单长度", () => {
    const desc = "d".repeat(1000);
    for (let i = 0; i < 30; i++) {
      putSkill(projectRoot, `h-${String(i).padStart(2, "0")}`, md(`description: ${desc}\ndisable-model-invocation: true`));
    }
    putSkill(projectRoot, "z-visible", md("description: shown"));
    const { skills, warnings } = loadSkills([]);
    assert.deepEqual(warnings, []);
    assert.equal(skills.find((s) => s.name === "z-visible")!.listed, true);
  });
});

describe("frontmatter 解析（经 loadSkills 观察）", () => {
  test("普通值", () => {
    assert.equal(descOf("description: hello world"), "hello world");
  });

  test("双引号还原 \\\" 与 \\\\", () => {
    assert.equal(descOf('description: "say \\"hi\\" and \\\\ back"'), 'say "hi" and \\ back');
  });

  test("单引号里的 '' 还原成一个引号", () => {
    assert.equal(descOf("description: 'it''s fine'"), "it's fine");
  });

  test("| 保留换行并去掉公共缩进", () => {
    assert.equal(descOf("description: |\n  line one\n    nested\n  line two\nname: probe"), "line one\n  nested\nline two");
  });

  test("> 折成一行", () => {
    assert.equal(descOf("description: >\n  folded\n  into one\n\n  line"), "folded into one line");
  });

  test("|- 与 | 一样取块，结尾空行去掉", () => {
    assert.equal(descOf("description: |-\n  a\n  b\n\n"), "a\nb");
  });

  test("块标记后面带注释也认", () => {
    assert.equal(descOf("description: | # note\n  kept"), "kept");
  });

  test("行尾 # 注释去掉", () => {
    assert.equal(descOf("description: hello # a comment"), "hello");
  });

  test("引号里的 # 不是注释，引号外的是", () => {
    assert.equal(descOf('description: "a # b" # c'), "a # b");
    assert.equal(descOf("description: 'x # y' # z"), "x # y");
  });

  test("前面没空白的 # 不算注释", () => {
    assert.equal(descOf("description: a#b"), "a#b");
  });

  test("不带引号的值可以缩进续行", () => {
    assert.equal(descOf("description: first\n  second\n  third"), "first second third");
  });

  test("续行里只有注释的一行被丢掉", () => {
    assert.equal(descOf("description: first\n  # just a comment\n  second"), "first second");
  });

  test("值为空、下一行是嵌套 key: 时不接成值", () => {
    putSkill(projectRoot, "nested", md("description:\n  author: someone"));
    const { skills, warnings } = loadSkills([]);
    assert.deepEqual(skills, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /description is required$/);
  });

  test("值为空、下一行是列表项时不接成值", () => {
    putSkill(projectRoot, "listy", md("description:\n  - a\n  - b"));
    assert.deepEqual(loadSkills([]).skills, []);
  });

  test("嵌套块之后的顶层字段照常解析", () => {
    putSkill(projectRoot, "meta", md("metadata:\n  author: x\n  tags: y\nname: named\ndescription: after nested"));
    const s = loadSkills([]).skills[0]!;
    assert.equal(s.name, "named");
    assert.equal(s.description, "after nested");
  });

  test("值为空时后面普通缩进行照样接上", () => {
    assert.equal(descOf("description:\n  wrapped text"), "wrapped text");
  });

  test("带引号的值不接续行", () => {
    putSkill(projectRoot, "probe", md('description: "quoted"\n  tail'));
    assert.equal(loadSkills([]).skills[0]!.description, "quoted");
  });

  test("CRLF 换行", () => {
    putSkill(projectRoot, "crlf", "---\r\nname: crlf\r\ndescription: windows\r\n---\r\nbody\r\n");
    assert.equal(loadSkills([]).skills[0]!.description, "windows");
  });

  test("文件开头的 BOM", () => {
    putSkill(projectRoot, "bom", "\uFEFF---\ndescription: with bom\n---\nbody\n");
    assert.equal(loadSkills([]).skills[0]!.description, "with bom");
  });

  test("认不出的行被跳过", () => {
    assert.equal(descOf("??? not a field\ndescription: ok\n: also not"), "ok");
  });

  test("冒号后没空格也认", () => {
    assert.equal(descOf("description:tight"), "tight");
  });
});

describe("skillsPrompt", () => {
  test("没有要列出的就是空串", () => {
    assert.equal(skillsPrompt({ skills: [], warnings: [] }), "");
    putSkill(projectRoot, "hid", md("description: d\ndisable-model-invocation: true"));
    assert.equal(skillsPrompt(loadSkills([])), "");
  });

  test("清单格式：说明、available_skills、每项名称描述路径", () => {
    const path = putSkill(projectRoot, "fmt", md("description: formats things"));
    const prompt = skillsPrompt(loadSkills([]));
    assert.ok(prompt.startsWith("\n\nThe following skills provide specialized instructions for specific tasks."));
    assert.ok(
      prompt.endsWith(
        `<available_skills>\n  <skill>\n    <name>fmt</name>\n    <description>formats things</description>\n    <location>${path}</location>\n  </skill>\n</available_skills>`,
      ),
    );
  });

  test("XML 特殊字符被转义", () => {
    putSkill(projectRoot, "esc", md(`description: a<b>&"c'd`));
    const prompt = skillsPrompt(loadSkills([]));
    assert.ok(prompt.includes("<description>a&lt;b&gt;&amp;&quot;c&apos;d</description>"));
  });

  test("不可调用但已列出的也进清单", () => {
    putSkill(projectRoot, "help", md("description: still listed"));
    assert.ok(skillsPrompt(loadSkills(["help"])).includes("<name>help</name>"));
  });
});

describe("readSkillBody", () => {
  test("去掉 frontmatter，首尾空白修掉", () => {
    putSkill(projectRoot, "body", md("description: d", "\n\n# Title\n\nStep 1\n\n"));
    const skill = loadSkills([]).skills[0]!;
    assert.equal(readSkillBody(skill), "# Title\n\nStep 1");
  });

  test("读的是调用时的文件内容", () => {
    const path = putSkill(projectRoot, "live", md("description: d", "v1"));
    const skill = loadSkills([]).skills[0]!;
    writeFileSync(path, md("description: d", "v2"));
    assert.equal(readSkillBody(skill), "v2");
  });

  test("超过 100KB 抛错", () => {
    putSkill(projectRoot, "huge", md("description: d", "x".repeat(101 * 1024)));
    const skill = loadSkills([]).skills[0]!;
    assert.throws(() => readSkillBody(skill), { message: "skill file is larger than 100KB" });
  });

  test("只有 frontmatter 没有正文时抛错", () => {
    putSkill(projectRoot, "empty", md("description: d", "   \n  "));
    const skill = loadSkills([]).skills[0]!;
    assert.throws(() => readSkillBody(skill), { message: "skill file has no instructions" });
  });

  test("文件后来去掉了 frontmatter 就整份当正文，BOM 去掉", () => {
    const path = putSkill(projectRoot, "plain", md("description: d"));
    const skill = loadSkills([]).skills[0]!;
    writeFileSync(path, "\uFEFFwhole file\n");
    assert.equal(readSkillBody(skill), "whole file");
  });
});
