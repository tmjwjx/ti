// 发现并加载 skill：扫目录、读 SKILL.md 开头的字段、生成给模型看的清单、按需读全文
import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const CATALOG_MAX = 20_000;
const HEAD_BYTES = 64 * 1024;
const BODY_MAX = 100 * 1024;
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type Skill = {
  name: string;
  description: string;
  path: string;
  dir: string;
  source: "project" | "user";
  hidden: boolean;
  listed: boolean;
  invocable: boolean;
};

export type SkillSet = { skills: Skill[]; warnings: string[] };

// 提示词清单开头的说明：什么时候去读 skill、相对路径怎么解析。和 pi 的原文一致
const CATALOG_HEAD = `The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.`;

type Frontmatter = { fields: Record<string, string>; body: string } | undefined;

// 去掉字段值两边的引号。双引号里的 \" 和 \\ 还原，单引号里的 '' 还原成一个引号
function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

// 去掉字段值后面的注释。# 前面是空白才算注释；引号里的 # 不算，所以先跳过开头那段引号
function stripComment(v: string): string {
  let from = 0;
  const q = v[0];
  if (q === '"' || q === "'") {
    let i = 1;
    for (; i < v.length; i++) {
      if (q === '"' && v[i] === "\\") {
        i += 1;
        continue;
      }
      if (v[i] !== q) continue;
      if (q === "'" && v[i + 1] === "'") {
        i += 1;
        continue;
      }
      break;
    }
    from = i + 1;
  }
  const at = v.slice(from).search(/(^|\s)#/);
  return at < 0 ? v : v.slice(0, from + at).trimEnd();
}

// 读取一个多行字段的值。| 保留换行，> 折成一行
function blockValue(lines: string[], from: number, fold: boolean): { value: string; next: number } {
  const taken: string[] = [];
  let i = from;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() && !/^\s/.test(line)) break;
    taken.push(line);
  }
  while (taken.length && !taken[taken.length - 1]!.trim()) taken.pop();
  const indent = Math.min(...taken.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
  const body = taken.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
  const value = fold ? body.join(" ").replace(/\s+/g, " ").trim() : body.join("\n").trim();
  return { value, next: i };
}

// 取出 SKILL.md 开头的字段和后面的正文。没有成对的 --- 就返回空；认不出的行跳过
function parseFrontmatter(text: string): Frontmatter {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return undefined;
  const head = lines.slice(1, end);
  const fields: Record<string, string> = {};
  for (let i = 0; i < head.length; ) {
    const m = head[i]!.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1]!;
    const raw = stripComment(m[2]!.trim());
    if (/^[|>][-+]?$/.test(raw)) {
      const { value, next } = blockValue(head, i + 1, raw.startsWith(">"));
      fields[key] = value;
      i = next;
      continue;
    }
    // 不带引号的值可以换行接着写：后面的缩进行用空格接上。值为空时，缩进行若像 key: 或 - 开头，是嵌套结构，不接
    const parts = [raw];
    let next = i + 1;
    if (!/^["']/.test(raw)) {
      while (next < head.length && /^\s+\S/.test(head[next]!)) {
        const line = head[next]!.trim();
        if (!raw && next === i + 1 && /^([A-Za-z0-9_-]+:(\s|$)|-(\s|$))/.test(line)) break;
        parts.push(stripComment(line));
        next += 1;
      }
    }
    fields[key] = unquote(parts.filter(Boolean).join(" "));
    i = next;
  }
  return { fields, body: lines.slice(end + 1).join("\n") };
}

// 读文件开头的一段，用来取字段。只读前 64KB，避免把大文件整份读进来
function readHead(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// 扫描一个 skills 目录，把其中的 SKILL.md 收成列表。目录不存在或读失败时返回空，原因记进 warnings
function scanRoot(root: string, source: Skill["source"], warnings: string[]): Skill[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const entry of names.sort()) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const dir = join(root, entry);
    const path = join(dir, "SKILL.md");
    if (!isDir(dir) || !isFile(path)) continue;
    let fm: Frontmatter;
    try {
      fm = parseFrontmatter(readHead(path));
    } catch (e) {
      warnings.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const description = fm?.fields.description?.trim() ?? "";
    if (!description) {
      warnings.push(`${path}: description is required`);
      continue;
    }
    const name = fm?.fields.name?.trim() || entry;
    if (name.length > NAME_MAX || !NAME_RE.test(name)) {
      warnings.push(`${path}: name "${name}" should be lowercase letters, digits and hyphens, at most ${NAME_MAX}`);
    }
    if (description.length > DESCRIPTION_MAX) {
      warnings.push(`${path}: description is longer than ${DESCRIPTION_MAX} characters, truncated`);
    }
    out.push({
      name,
      description: description.slice(0, DESCRIPTION_MAX),
      path,
      dir,
      source,
      hidden: fm?.fields["disable-model-invocation"]?.trim() === "true",
      listed: false,
      invocable: true,
    });
  }
  return out;
}

function realpathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function catalogEntry(s: Skill): string {
  return `  <skill>
    <name>${escapeXml(s.name)}</name>
    <description>${escapeXml(s.description)}</description>
    <location>${escapeXml(s.path)}</location>
  </skill>`;
}

// 加载当前项目和用户目录里的 skill，返回列表和警告。reserved 是内置命令名，同名的 skill 不能用 /名字 调用
export function loadSkills(reserved: string[]): SkillSet {
  const warnings: string[] = [];
  const roots: [string, Skill["source"], string][] = [
    [join(process.cwd(), ".ti", "skills"), "project", ".ti/skills"],
    [join(homedir(), ".ti", "skills"), "user", "~/.ti/skills"],
  ];
  const byName = new Map<string, { skill: Skill; label: string }>();
  const seen = new Set<string>();
  for (const [root, source, label] of roots) {
    for (const skill of scanRoot(root, source, warnings)) {
      const real = realpathOf(skill.path);
      if (seen.has(real)) continue;
      seen.add(real);
      const won = byName.get(skill.name);
      if (won) {
        warnings.push(`name "${skill.name}" in ${label} is shadowed by ${won.label}`);
        continue;
      }
      byName.set(skill.name, { skill, label });
    }
  }
  const skills = [...byName.values()].map((v) => v.skill);
  const taken = new Set(reserved);
  for (const s of skills) {
    if (/\s/.test(s.name)) {
      s.invocable = false;
      warnings.push(`skill "${s.name}" has whitespace in its name and cannot be run as a command`);
    } else if (taken.has(s.name)) {
      s.invocable = false;
      warnings.push(`skill "${s.name}" is shadowed by the /${s.name} command`);
    }
  }
  // 按顺序决定哪些放进提示词。超过长度上限的不放，仍可手动调用
  let size = CATALOG_HEAD.length;
  let dropped = 0;
  for (const s of skills) {
    if (s.hidden) continue;
    const add = catalogEntry(s).length + 1;
    if (size + add > CATALOG_MAX) {
      dropped += 1;
      continue;
    }
    size += add;
    s.listed = true;
  }
  if (dropped) warnings.push(`skills catalog is full, ${dropped} skill${dropped === 1 ? "" : "s"} not listed`);
  return { skills, warnings };
}

// 生成系统提示词里的 skill 清单。没有要列出的就返回空串
export function skillsPrompt(set: SkillSet): string {
  const listed = set.skills.filter((s) => s.listed);
  if (!listed.length) return "";
  return `\n\n${CATALOG_HEAD}\n\n<available_skills>\n${listed.map(catalogEntry).join("\n")}\n</available_skills>`;
}

// 读出一份 skill 的操作说明，不含开头的字段。文件过大或没有正文时抛错
export function readSkillBody(skill: Skill): string {
  const size = statSync(skill.path).size;
  if (size > BODY_MAX) throw new Error(`skill file is larger than ${BODY_MAX / 1024}KB`);
  const text = readFileSync(skill.path, "utf8");
  const fm = parseFrontmatter(text);
  const body = (fm ? fm.body : text.replace(/^\uFEFF/, "")).trim();
  if (!body) throw new Error("skill file has no instructions");
  return body;
}
