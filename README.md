# ti

终端 coding agent：读文件、改代码、跑命令。

```bash
npm i -g @tmjwjx/ti
ti
```

Node ≥ 22.18. First run opens a setup picker for provider, model, and API key. Config lives at `~/.ti/settings.json`. Re-run anytime with `ti setup`.

```
/clear      clear conversation
/model      switch configured model
/provider   switch configured provider
/setup      add or edit provider
/exit       quit
```

Start it in the project directory you want to work on.
