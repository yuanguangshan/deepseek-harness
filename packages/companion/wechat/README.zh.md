# @deepseek-ai/dsh-wechat

[English](README.md) | 中文

面向模型的 `wechat_send` 工具：通过本机 wechat-send 技能脚本向微信发送纯文本消息。

## 功能

在 `ctx.tools` 上注册一个工具 `wechat_send(text)`。执行时以 argv 参数和 `--weclaw-first` 派生 `~/.pi/agent/skills/wechat-send/scripts/send.py`（Python 3）：优先尝试 WECLAW 通道，回退到本机 weixinpush 通道。载荷通过 argv 数组传递，不做 shell 插值，因此引号、换行、哈希和 HTML 都安全。任何挂载此插件的宿主或 agent（web、dsh-tui、repl，或打包了该包的 headless profile）都可以让模型发送微信消息。

结果是简短的中文状态行：成功时 `已发送到微信（channel=…）`，否则是脚本的错误文本；脚本无输出时报告发送失败而不是假装成功。

## 前置条件

该工具只是宿主侧技能脚本的薄调度器。只有宿主具备以下条件时发送才能工作：

- Python 3（`python3`，或 `WECHAT_SEND_PY` 覆盖）。
- wechat-send 技能位于 `~/.pi/agent/skills/wechat-send/scripts/send.py`（或 `WECHAT_SEND_SCRIPT` 覆盖），且至少有一个可达的微信通道。

## 配置

两个宿主路径在模块加载时从环境读取，不是经过校验的 `Config` 字段：

- `WECHAT_SEND_SCRIPT` — 发送脚本路径（默认 `~/.pi/agent/skills/wechat-send/scripts/send.py`）。
- `WECHAT_SEND_PY` — Python 解释器（默认 `python3`）。

30 秒预算会杀掉卡住的脚本；被杀会报告发送失败。

## 校验

`schema` 要求非空 `text` 字符串。`execute` 拒绝纯空白消息（`没有可发送的内容（空文本）`）；其余失败都以脚本的错误文本呈现，而不是静默成功。

## 导出形态

函数/命名空间插件：导出 `name` / `inject` / `apply`，无 default 导出。多余的 `export default` 会让 Loader 的 `unwrapExports` 折叠模块并丢掉 `inject`（见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)）。

## Model Experience

### Tool schema

#### What the model sees

模型看到生成的 [`wechat_send` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-wechat) 及其面向模型的描述。

#### Token effect

工具可见时每次请求的固定 schema 成本。

#### KV Cache effect

定义与可见性不变时前缀稳定。插件生命周期或作用域限制可能使该 schema 的复用失效。

### Tool-call history and result

#### What the model sees

每次调用的 `text` 保留在参数里；结果是简短状态行或脚本的错误文本。

#### Token effect

每次调用一行短文本。

#### KV Cache effect

独立；该工具既不组装也不发送 provider 请求。

## 已知限制与待办

- **宿主侧技能依赖** — 该工具只负责调度；发送需要宿主 Python 脚本和至少一个已配置的微信通道。没有这些时每次调用都报告失败。
- **环境变量配置** — 脚本与解释器路径在模块加载时从环境读取，不是经过校验的 `Config` 字段；需要按实例配置路径的部署必须在挂载插件前设置变量。
- **仅纯文本** — 工具按原样发送原始文本；不支持图片、文件或格式。
