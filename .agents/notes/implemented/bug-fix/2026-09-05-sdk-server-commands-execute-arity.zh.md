# Agent Note：SDK server `commands.execute` 参数错位导致 `session/command` 全坏

Status: implemented

[English](2026-09-05-sdk-server-commands-execute-arity.md) | 中文

## Problem

`HarnessSdkJsonRpcServer.command` 通过本地结构接口探测可选的 `commands` 服务，并以三个参数调用：`execute(agent, line, signal)`。而真实的 `@deepseek-ai/dsh-commands` 服务自 composer 图片路由合入（`8d9fee19f9`）起第三个参数是 `images`，签名为 `execute(agent, line, images, signal)`。`ctx.get('commands') as CommandsService` 的强转抹掉了这处漂移：运行时 `AbortSignal` 绑到了 `images` 上，`signal` 保持 `undefined`，第一处 `signal.aborted` 读取即抛 `TypeError: Cannot read properties of undefined (reading 'aborted')`——凡是组合了 commands 服务的 `session/command` 调用全部失败，包括 REPL TUI 的 `/compact`（其服务端斜杠命令正走这个方法）。真插件的 `session/command` 测试在 master 上本来就是红的；其余调用没有使用三参形态，所以没有任何东西拦住这次漂移。

## Decision

镜像可选服务的结构接口必须跟随真实方法签名：server 侧 `CommandsService.execute` 现在在 signal 之前声明 `images: readonly EncodedImageAttachment[]`，调用点传空列表——JSON-RPC wire 的命令不携带附件，接收图片的命令通过先行的 `session/attach` 拿到图片。既有的真插件测试已经端到端覆盖了正确参数形态，不需要新增测试面。
