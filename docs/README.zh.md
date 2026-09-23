# ti

[English](../README.md) | 中文

终端里的 coding agent：读文件、改代码、跑命令。

## 安装

```bash
npm i -g @tmjwjx/ti
```

需要 Node ≥ 22.18。已经装过的用 `ti update` 更新。

## 首次运行

在要干活的项目目录里运行 `ti`。第一次会弹出配置向导，选厂家、模型，填 API key。之后要改就运行 `ti setup`。

```
ti [setup | update] [--provider name] [-m model] [--resume] [--version]
```

## 命令

```
/clear      清空对话
/compact    压缩上下文
/resume     恢复本目录的会话
/rename     给当前会话改名
/model      切换已配置的模型
/provider   切换已配置的厂家
/setup      添加或修改厂家
/cost       token 用量
/skills     列出 skills
/help       列出命令
/exit       退出
```

## 快捷键

```
enter            发送
shift+enter      换行（或者输入 \ 再回车）
↑ / ↓            历史
esc              打断 / 返回
ctrl+c           清空 · 打断 · 退出
pageup/pagedown  滚动
```

## 会话、压缩、skills

- **会话**存在启动目录的 `.ti/sessions/` 里。`--resume` 和 `/resume` 只列当前项目的。
- **压缩**：`/compact` 把较早的消息写成摘要，保留最近的。上下文变大时也会自动压缩。
- **skills**：把 `SKILL.md` 放在 `.ti/skills/<名字>/` 或 `~/.ti/skills/<名字>/` 下。任务和描述对得上时模型会自己去读；`/<名字> 参数` 直接调用。

## 许可

MIT
