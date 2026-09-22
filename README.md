# ti

终端 coding agent：读文件、改代码、跑命令。

```bash
npm i -g @tmjwjx/ti
ti
```

Node ≥ 22.18. First run opens a setup picker for provider, model, and API key. Config lives at `~/.ti/settings.json`. Re-run anytime with `ti setup`.

```
ti [--provider name] [-m model] [--resume]
```

Sessions are stored in `.ti/sessions/` of the directory you start from. `--resume` and `/resume` only list this project. `/clear` keeps the old file and starts a new one on the next message.

```
/clear      clear conversation
/resume     resume a session in this directory
/rename     rename this session
/model      switch configured model
/provider   switch configured provider
/setup      add or edit provider
/cost       token usage
/help       list commands
/exit       quit
```

Start it in the project directory you want to work on. Add `.ti/` to that project's `.gitignore`.
