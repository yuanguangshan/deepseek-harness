# Agent Note: 在 TUI REPL 中按 ESC 中断当前回合

Status: implemented

[English](2026-08-14-repl-escape-interrupt.md) | 中文

## 问题

交互式 TUI REPL（`apps/repl/tui-repl.mjs`）在 agent 回合进行时，通过 `session.event` 事件总线流式输出模型结果。此前没有在回合进行中停止它、并留在会话里的方式：输入要么是整行缓冲、要么归编辑器所有，唯一全局键绑定（`Ctrl+C`）会直接退出整个进程。提交了一个很长或错误的提示后，用户只能等回合结束（或直接关掉整个运行时）才能继续。

## 决定

端到端新增 `session.cancel` JSON-RPC 方法，并从 TUI 把 ESC 接到它上面：

- **Wire 契约**（`packages/sdk/protocol`）：新增 `SessionCancelParams { sessionId }` 与 `SessionCancelResult { accepted: true }`，在 `HarnessSdkRequestMap` 上注册为 `session.cancel`。命名与 web BFF 已有的 `session.cancel`（`packages/host/apiproxy`）对齐，后者已用相同语义停止活动回合。
- **服务端**（`packages/sdk/server`，即 REPL 驱动的 `dsh-jsonrpc-agent` 运行时）：新增 `cancel()` 处理器，解析所属 agent 并调用 `agent.cancel({ kind: 'user' }, { keepInbox: true })`，保留待处理的 inbox 工作，使排队中的后续消息在中断后继续存在。`handleRequest` 把 `session/cancel` 路由到它。未知会话会拒绝（与 `prompt`/`command` 路由共用 `getOrCreateSession`）。
- **客户端**（`packages/sdk/client`）：新增带类型的 `cancel(sessionId)`，发出 `session/cancel` 并确认 `accepted`。
- **TUI**（`apps/repl/tui-repl.mjs`）：全局输入监听在 `busy`（流式输出中）时收到 `escape`，发起一次 `client.cancel`，显示"中断中…"状态，并返回 `{ consume: true }` 以免该键继续被分发给编辑器。空闲时 ESC 照常下沉给编辑器（如关闭补全）。在 `turn/end` 时，用户主动发起的中断（由 `interruptRequested` 标志跟踪）不再显示为红色"turn 异常"；现有的 `finishTurn()` 恢复编辑器以接收下一轮输入。

## 备选方案

**仅前端假停止** — 拒绝。只在显示器停、运行时继续跑会误报状态，且后端仍会继续消耗 token/工具；中断必须触达 agent 循环。

**复用 web BFF 的 `session.cancel`** — 拒绝。REPL 驱动的是独立的 `dsh-jsonrpc-agent` SDK 运行时（stdio JSON-RPC），不是 `apiproxy` HTTP 门面，因此该方法须加到 SDK wire 协议上。

**用 Ctrl+C 作为中断键** — 拒绝。Ctrl+C 是两个 REPL 实现既有的"退出进程"绑定；用它做中断会令人意外，且流式输出期间无法兼顾退出。

## 后果

流式回合可在中途停下，且会话仍可用于下一条提示。中断是用户 `kind` 原因，以 `aborted` 的 reason 终止 `turn/end`，并保留 inbox，因此取消之前提交的提示之后仍会执行。行式 REPL（`repl.mjs`）与 web app 已有各自语义，均未改动；行式是整行缓冲，无法逐键感知 ESC。

改到本文件时也顺手收紧了 `command()`：它通过结构化的 `CommandsService` 类型探测可选的 `dsh-commands` 服务，并去掉了冗余的 `agent === undefined` 判断（handle 的 `agent` 非可选），清除了既有的 `no-unsafe-*`/`no-unnecessary-condition` lint，同时不引入对 `dsh-commands` 的硬依赖。

## 验证

`packages/sdk/server/tests/server.spec.ts` 覆盖 `session.cancel`：直接 `cancel()` 的回执与 JSON-RPC 派发两条路径都断言 `agent.cancel` 以 `{ kind: 'user' }` 和 `{ keepInbox: true }` 被调用。SDK client/server/protocol 测试套件仍通过；TUI 改动经 `pnpm run build` 产出，并做交互验证。
