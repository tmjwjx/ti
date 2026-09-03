# ti

终端 coding agent：读文件、改代码、跑命令。

```bash
npm i -g @tmjwjx/ti
ti
ti -p "你的任务"
```

需要 Node ≥ 22.18。第一次运行若没有配置，会创建 `~/.ti/settings.json`，填入 `apiKey` 后即可使用。

```
/clear      清空对话
/model      查看或切换模型
/provider   查看或切换厂家
/exit       退出
```

在要操作的项目目录里启动。
