# skills —— 开发大纲

> 对应包号 0.0.6 · 需求已定 · 本文是这一版的开发依据
> 功能背景与验收见 `docs/PRD.md`「skills」；分层约束见 `docs/DESIGN.md` §1–§2

## 0. 已定的取舍

| 项 | 定了什么 |
|---|---|
| 扫哪些目录 | `<cwd>/.ti/skills/<名字>/SKILL.md`，再 `~/.ti/skills/<名字>/SKILL.md`。同名项目级优先 |
| 目录规则 | 只看当前目录，不往上找 git 根；只认一层，不递归；跟随符号链接，同一真实文件只算一次；跳过 `.` 开头的目录和 `node_modules` |
| frontmatter | 手写解析，不引 yaml 库。只认 `name`、`description`、`disable-model-invocation` |
| 校验 | 照 pi：缺 `description` 不加载；名字不合规、描述超 1024 字符只警告，照常加载，描述截到 1024 |
| 系统提示词 | 照 pi 的 `<available_skills>` 格式，只列名字、描述、路径。模型按需用 `read` 读全文 |
| 清单上限 | 2 万字符。超出的不进清单、记警告，仍可 `/名字` 手动调 |
| 手动调用 | 照 dsh：`/名字 参数`，不加 `skill:` 前缀。全文和参数在这一轮发给模型（注入格式照 pi） |
| 撞名 | 内置命令优先。skill 和内置命令同名时不能用 `/名字` 调，记警告，模型照样能读 |
| 存法 | 单独的 `skill` 角色，存调用那一刻读到的全文。没有存量文件，格式直接改，不升版本号 |
| 查看 | `/skills` 列出已加载的、来源、警告。启动时不额外提示 |
| 刷新 | 只在启动时扫一次，新加的要重启 ti |
| 顺带修 | TUI 命令列表回车会丢参数（`/rename foo` 只提交了 `/rename`） |
| 顺带删 | 建会话时自动往用户项目 `.gitignore` 加 `.ti/`（已删，随本版提交） |

参考了三家：pi 扫 `~/.pi/agent/skills`、`~/.agents/skills`、`.pi/skills`、`.agents/skills`，提示词列清单让模型用 `read` 读，另有 `/skill:名字`；Codex 扫 `~/.agents/skills` 与项目 `.agents/skills`，提示词另加「用户点名或任务匹配就必须读」；dsh 用专门的 `skill` 工具加载，`/名字` 手动调，内置命令先于 skill 解析。ti 的清单和注入取 pi 的做法，手动调用的写法取 dsh 的 `/名字`，目录只用 ti 自己的两处。

## 1. 整体思路

一句话需求：把一份写好的操作说明放进固定目录，模型在需要时能找到并照做，用户也能手动点名让它照做。

```
启动
  loadSkills() 扫两处目录 → skills[] + warnings[]
     ├─→ buildSystemPrompt(skills)  清单进系统提示词（只有名字、描述、路径）
     └─→ repl(…, skills)            /skills 列表、/名字、命令列表补全

模型自己用                             用户手动调
  看到清单里的描述对得上                   /db-migrate 加一张 orders 表
  → read(location) 读全文 → 照做         → 读全文，存成 skill 角色 → 这一轮发给模型
```

- **渐进披露**：平时上下文里只有一行描述，全文用到时才进来。这是 pi 的机制，ti 不新增工具。
- **手动调用**是为了「模型不一定会去读」这个问题（pi 文档原话：models don't always do this）。全文直接进这一轮，模型一定看得到。

## 2. 需求覆盖

| 需求 | 由哪块实现 | 判定标准 |
|---|---|---|
| 放一个 skill 就能被发现 | §3.1 | 在 `.ti/skills/demo/SKILL.md` 写好 frontmatter，重启 ti，`/skills` 里有 `demo` |
| 模型按需读 | §3.3 | 提一个和 `demo` 描述对得上的任务，模型先 `read` 了那份 `SKILL.md` 再动手 |
| 手动调用 | §3.4 | `/demo 参数`，这一轮请求里有 `<skill name="demo" …>` 全文和参数 |
| 内置命令不被抢 | §3.4 | 放一个叫 `clear` 的 skill，`/clear` 仍是清空对话，`/skills` 里有撞名警告 |
| 同名项目级优先 | §3.1 | 两处都有 `demo`，`/skills` 显示项目那份，并有一条覆盖警告 |
| 隐藏的只能手动调 | §3.2 | `disable-model-invocation: true` 的不在系统提示词里，`/名字` 能调 |
| 恢复后上下文不变 | §3.4 | 调用后改掉 `SKILL.md`，`--resume` 接上，发出去的仍是调用时的全文 |
| 参数不丢 | §3.6 | TUI 里 `/rename foo` 回车，会话名变成 `foo` |

## 3. 实现逻辑

### 3.1 扫描（新文件 `src/core/skills.ts`）

```ts
export type Skill = {
  name: string;
  description: string;
  path: string;               // SKILL.md 的绝对路径
  dir: string;                // 所在目录，相对路径按它解析
  source: "project" | "user";
  hidden: boolean;            // disable-model-invocation: true
  listed: boolean;            // 进没进系统提示词清单（上限挤掉的为 false）
};
export type SkillSet = { skills: Skill[]; warnings: string[] };

export function loadSkills(reserved: string[]): SkillSet;  // reserved：内置命令名，撞名的记警告
export function skillsPrompt(set: SkillSet): string;      // 清单片段，没有可列的返回 ""
export function readSkillBody(skill: Skill): string;      // 全文去掉 frontmatter
```

- 顺序：先 `<cwd>/.ti/skills`，再 `~/.ti/skills`。每个目录 `readdirSync`，对每一项 `statSync`（跟随符号链接）确认是目录，再看里面有没有 `SKILL.md`。
- 跳过：`.` 开头的、`node_modules`、不是目录的、没有 `SKILL.md` 的。
- 同一个真实文件（`realpathSync`）只算一次，重复的静默跳过（两个目录软链到同一处很常见）。
- 同名：先扫到的赢，后面的记一条警告 `name "demo" in ~/.ti/skills is shadowed by .ti/skills`。
- 目录不存在、读不了：当没有，不报错。单个文件读失败：记警告，跳过。
- 最终按「项目在前、用户在后，各自按名字排序」排好，清单和 `/skills` 都用这个顺序。

### 3.2 解析 SKILL.md

- 只读文件前 64KB 找 frontmatter，不把大文件整份读进来。
- 去掉开头的 BOM；第一行必须是 `---`，读到下一行 `---` 为止。没有 frontmatter 就当缺 `description`，不加载。
- pi 用 `yaml` 库整段解析，ti 零依赖，只能手写。支持的写法：
  - `key: value`
  - `key: "value"` / `key: 'value'`（去引号；双引号里认 `\"` 和 `\\`，单引号里认 `''`）
  - `key: |` / `key: >`（以及 `|-`、`>-`）：收后面所有缩进行，`|` 按换行拼，`>` 按空格拼，去掉公共缩进
  - 不带引号的值换行接着写：后面的缩进行用空格接上。值为空且下一行像 `key:` 或 `- ` 开头，当成嵌套结构，不接
  - 行尾注释：引号外面、前面是空白的 `#` 到行尾去掉。`a#b` 不算注释，`"has # inside"` 里的也不算
- 不支持：锚点、`|2` 这类缩进指示符、跨行的引号字符串。解析不出 `description` 就不加载，`/skills` 里有警告
- 只取 `name`、`description`、`disable-model-invocation`（值为 `true` 才算），其他键、嵌套结构一律忽略。
- `name` 没写就用目录名。
- 校验（照 pi，只警告不拦）：名字须是小写字母、数字、连字符（`^[a-z0-9]+(-[a-z0-9]+)*$`），不超过 64；描述不超过 1024，超了截断。
- **名字里有空白**：无法用 `/名字` 调用，记警告，仍进清单（模型用 `read` 读不受影响）。

### 3.3 系统提示词

`buildSystemPrompt(skills)` 在项目上下文（AGENTS.md / CLAUDE.md）之后追加 `skillsPrompt(skills)`。文字照抄 pi。不加 Codex 那句「用户点名就先读」：`/名字` 已经把全文放进这一轮，那句会让模型再 `read` 一遍。

```text
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>demo</name>
    <description>…</description>
    <location>/abs/path/.ti/skills/demo/SKILL.md</location>
  </skill>
</available_skills>
```

- `hidden` 的不列。
- 三个字段做 XML 转义（`& < > " '`），和 pi 一样。
- **上限**：按 §3.1 的顺序逐个累加，加上这一条会超过 2 万字符就停，后面的 `listed = false`，记一条警告 `skills catalog is full, 3 skills not listed`。被挤掉的仍能 `/名字` 手动调。
- 没有可列的 skill：整段不加。

系统提示词在整个进程里不变，前缀缓存一直命中。

### 3.4 `/名字 参数`

**类型**（`src/types.ts`）：

```ts
export type SkillMessage = {
  role: "skill";
  name: string;
  path: string;   // 调用时的 SKILL.md 路径
  body: string;   // 调用那一刻读到的全文（去掉 frontmatter）
  args: string;   // /名字 后面的文字，可以为空
};
export type Message = LlmMessage | SummaryMessage | SkillMessage;
```

**调用**（`repl.ts` 的 `dispatch`）：

1. **解析顺序**：`/` 开头的一行，先按现在的规则匹配内置命令（`/clear`、`/model`、`/skills` 等，以及 `/quit`）。都不是，才取 `/` 之后到第一个空白为止当名字，去 `skills` 里找，后面 trim 后当参数。
2. 名字也不是 skill：照旧提示 `unknown command /xxx · type / for the list`，不发给模型。
3. **撞名**：`loadSkills` 拿到内置命令名单（`repl.ts` 传进去，`core` 不反向依赖 `cli`），和其中之一同名的 skill 记警告 `skill "clear" is shadowed by the /clear command`。它照样进系统提示词清单，模型能用 `read` 读，只是不能用 `/clear` 手动调。
4. `readSkillBody` 读全文：读失败或超过 100KB，红字报错，不发。这么大的 skill 整份塞进上下文不合理，应该拆成 `SKILL.md` 加 `references/`。
5. 之后走和普通聊天完全相同的一条路：发请求前的自动压缩检查 → `pushMessage(skillMsg)` → `agentTurn` → 超限兜底重试 → 失败撤回。把现在写在 `dispatch` 末尾的这一段抽成一个函数，普通输入和 skill 调用共用。
6. TUI 里命中 skill 的那一行和聊天一样设 busy（Esc 能打断、底栏显示 `esc interrupt`）。现在是「`/` 开头就不设 busy，`/compact` 例外」，改成「内置命令不设 busy，`/compact` 和 skill 设」。

**发给模型时**（`toLlm` 里，照抄 pi 的 `_expandSkillCommand`）：

```text
<skill name="demo" location="/abs/.ti/skills/demo/SKILL.md">
References are relative to /abs/.ti/skills/demo.

{body}
</skill>

{args}          ← 没有参数就没有这一段
```

翻成一条 user，和前后相邻的 user 照旧合并。

**存的是调用那一刻的全文**：之后 `SKILL.md` 改了、删了，恢复会话发出去的仍是当时那份。上下文要能复现。

### 3.5 各处接上 `skill` 角色

| 位置 | 改法 |
|---|---|
| `llm/index.ts` `toLlm` | `skill` → 上面的 user 文本 |
| `core/session.ts` `asMessage` | 认 `skill`：`name`、`path`、`body` 须为字符串且 `name`、`body` 非空；`args` 缺了当空字符串 |
| `core/session.ts` `repairMessages` | `skill` 和 user 一样当分界 |
| `core/session.ts` 会话起名（`pushMessage`、`openSession`、`listSessions`、`peekName`） | 现在取第一条 user 的首行。改成取第一条「用户输入」：user 取文本，`skill` 取 `/名字 参数`。抽一个 `inputText(msg)` 四处共用 |
| `core/compact.ts` `estimateTokens` | 估 `body` 加 `args` |
| `core/compact.ts` `serialize` | `[User]: /名字 参数`，下面接 `[Skill 名字]: 全文前 2000 字符`（截断标记同工具结果） |
| `core/agent.ts` `unmatchedToolCalls` | 碰到非 toolResult、非 assistant 就返回空，`skill` 已被覆盖，不改 |
| `cli/render.ts` `replayMessages` | 画成用户那样：`❯ /名字 参数`，不画全文 |
| `cli/repl.ts` `typedByUser` | `skill` 也进 ↑ 历史，文本是 `/名字 参数` |
| `cli/repl.ts` 撤回判断 `tailIsTurn` | 现在比的是「末尾是 user 且内容等于这一行」。改成比对象：`messages[messages.length - 1] === pushed`。user 和 `skill` 共用，也不会被内容恰好相同的旧消息骗到 |

### 3.6 命令列表与 `/skills`

- `COMMANDS` 加 `{ name: "/skills", hint: "list skills" }`，`/help` 里也就有了。
- TUI 的命令列表：`setCommands([...COMMANDS, ...每个 skill 一项])`，每项 `name` 是 `/名字`，`hint` 是描述的前 60 字符，内置命令排在前面。名字里有空白的、和内置命令撞名的不进列表。
- **修回车丢参数**：现在只要列表里有匹配项，回车就提交列表项的 `name`，后面的参数全丢（`/rename foo` → `/rename`，已用脚本复现）。改成：输入里第一个空白之后还有内容时，回车直接提交整行输入，列表只负责补全命令本身。`/model`、`/provider` 的二级列表项本身就带参数（`/model xxx`），不受影响。
- `/skills` 输出：

```text
demo          project  Extracts text and tables from PDF files…
commit-msg    user     Write commit messages in this repo's style
secret-tool   user     (hidden) …
bulk-thing    user     (not listed) …

warnings
  ~/.ti/skills/bad/SKILL.md: description is required
  name "demo" in ~/.ti/skills is shadowed by .ti/skills
  skill "clear" is shadowed by the /clear command
```

  没有任何 skill：`no skills · put SKILL.md under .ti/skills/<name>/ or ~/.ti/skills/<name>/`。管道模式也能用。

### 3.7 装配（`main.ts`）

```ts
const skillSet = loadSkills(commandNames());   // repl.ts 导出内置命令名单
const systemPrompt = await buildSystemPrompt(skillSet);
await repl(messages, { systemPrompt, ui }, tui, skillSet);
```

`loadSkills` 在 `setProvider` 之后、`--resume` 之前调。不放进模块级全局变量，`repl` 拿到的就是这一份。

## 4. 落点

| 文件 | 改什么 |
|---|---|
| `src/core/skills.ts`（新） | 扫描、frontmatter 解析、校验、清单片段、读全文 |
| `src/core/prompt.ts` | `buildSystemPrompt(skills)` 追加清单 |
| `src/types.ts` | `SkillMessage`；`Message` 扩一种 |
| `src/llm/index.ts` | `toLlm` 翻 `skill` |
| `src/core/session.ts` | `asMessage`、`repairMessages` 认 `skill`；`inputText()` 统一起名 |
| `src/core/compact.ts` | `estimateTokens`、`serialize` 认 `skill` |
| `src/cli/render.ts` | 重放 `skill` |
| `src/cli/repl.ts` | `/名字`（内置命令之后才找 skill）、`/skills`；busy 判断；聊天路径抽成函数共用；撤回改比对象；`typedByUser` 带上 `skill`；命令列表加 skill |
| `src/cli/tui.ts` | 回车带参数时提交整行 |
| `src/main.ts` | 装配 `loadSkills` |
| `package.json` / `package-lock.json` | `0.0.6`（CR 之后） |
| 文档 | `ARCHITECTURE.md`、`READING.md`、`VERSIONS.md`、README 命令表 |

## 4.1 已知风险

- **skill 等于直接指挥模型**：内容会让模型做任何事，带的脚本也会不经确认就跑。`.ti/skills` 和 `~/.ti/skills` 都是用户自己放的，信任程度同 `AGENTS.md`。ti 本来就没有权限确认，不是新的风险面。
- **手写 YAML 解析不完整**：只覆盖 §3.2 列的写法。别的写法（比如锚点、多文档）解析不出 `description` 就不加载，`/skills` 里有警告。
- **清单被挤掉的 skill 模型看不到**：只能手动调。`/skills` 里标 `(not listed)`。

## 5. 不做

`/reload`；`.agents/skills`、`~/.agents/skills` 等其他目录；在 settings 里配额外目录（要用别处的可以软链进 `~/.ti/skills`）；往上找 git 根；递归找 `SKILL.md`；`allowed-tools`、`license` 等其他 frontmatter 字段；`/名字` 的二级参数补全；skill 市场或包管理；启动时打印警告。

## 6. 待确认

无。
