# ti

English | [中文](https://github.com/tmjwjx/ti/blob/main/docs/README.zh.md)

A coding agent for the terminal. It reads files, edits code, and runs commands.

## Install

```bash
npm i -g @tmjwjx/ti
```

Requires Node ≥ 22.18.

## First run

Start `ti` in the project directory you want to work on. The first run opens a setup picker for provider, model, and API key. Run `ti setup` to change it later.

```
ti [setup] [--provider name] [-m model] [--resume] [--version]
```

## Commands

```
/clear      clear conversation
/compact    compact context
/resume     resume a session in this directory
/rename     rename this session
/model      switch configured model
/provider   switch configured provider
/setup      add or edit provider
/cost       token usage
/skills     list skills
/help       list commands
/exit       quit
```

## Keys

```
enter            send
shift+enter      newline (or \ then enter)
↑ / ↓            history
esc              interrupt / back
ctrl+c           clear · interrupt · quit
pageup/pagedown  scroll
```

## Sessions, compaction, skills

- **Sessions** are saved in `.ti/sessions/` of the directory you start from. `--resume` and `/resume` list this project only.
- **Compaction**: `/compact` summarizes older messages and keeps the recent ones. It also runs automatically when the context gets large.
- **Skills**: put `SKILL.md` under `.ti/skills/<name>/` or `~/.ti/skills/<name>/`. The model reads a skill when the task matches its description; `/<name> args` runs it directly.

## License

MIT
