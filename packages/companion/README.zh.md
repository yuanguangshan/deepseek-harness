# companion/ — 个人伴侣能力

[English](README.md) | 中文

从 dsh-repl TUI 抽取的能力，任何前端或 agent 运行时都可复用。每个包都是纯逻辑库（无 Cordis 服务）：胶水由调用方负责。

| 包 | 职责 | ctx key |
|---|---|---|
| [`memory/`](memory/README.zh.md) | 长期记忆存储：五个 markdown 轨道 + prompt 快照渲染。 | （库，无 ctx key） |
| [`tool-companion/`](tool-companion/README.zh.md) | 面向模型的 `memory` + `usage_status` 工具，基于这两个库。 | `ctx.tools` |
| [`usage/`](usage/README.zh.md) | API 用量/配额状态：opencode go 窗口 + DeepSeek 余额。 | （库，无 ctx key） |
| [`wechat/`](wechat/README.zh.md) | 面向模型的 `wechat_send` 工具，基于宿主侧 wechat-send 技能脚本。 | `ctx.tools` |

子 README 拥有存储布局、端点和渲染契约。
