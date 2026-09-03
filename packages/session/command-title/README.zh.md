# @deepseek-ai/dsh-command-title

[English](README.md) | 中文

面向人的 `/rename <标题>` 斜杠命令，用于固定当前会话标题。命令把校验与接受委托给 `ctx.sessionTitle.rename()`（见 [`@deepseek-ai/dsh-session-title`](../session-title)）：它追加 `user` 来源的 `session/title` 事件，同时停止该会话的自动起名。

## 行为

- `/rename` 或 `/rename   `（仅空白）返回 `Usage: /rename <new title>`，不写日志。
- `/rename <标题>` 归一化文本、追加 `session/title` 事件，返回 `Title set: <归一化标题>`。
- 领域校验失败（`SessionTitleInvalidError` —— 例如归一化后为空或超过 `maxTitleBytes`）返回携带服务消息的用法错误结果。
- 处理器的其他失败原样向执行器传播。

## 用法

```yaml
# cordis.yml
- id: command-title
  name: '@deepseek-ai/dsh-command-title'
```

插件注入 `commands` 与 `sessionTitle`；注册一个名为 `rename` 的全局命令，描述符为：

```json
{ "name": "rename", "description": "rename the current session (pins the title; automatic generation stops)", "input": { "hint": "<new title>" } }
```

卸载插件即注销该命令。

## 模型体验

### `/rename` 命令状态

#### 模型看到什么

什么都不看到。`/rename` 是 UI 命令接缝：处理器运行 `ctx.sessionTitle.rename()` 并追加仅入日志的 `session/title` 事件，该事件不进入会话面、`deriveMessages()`、系统提示、工具 schema 或请求前缀。

#### Token 影响

零。命令结果文本只返回给发起调用的客户端；标题事件不给任何 agent 请求增加 token。

#### KV Cache 影响

无。标题事件不改变重建的请求内容或缓存键。

## 已知限制与暂缓事项

- 本命令不接受作用域变体：始终重命名发起调用的 agent 所属会话，不提供批量或跨会话改名。
- 输入语法只有单个提示（`<new title>`）；富编辑（多行标题、附件）不受支持，调用形状不匹配时静默回退为用法提示。
