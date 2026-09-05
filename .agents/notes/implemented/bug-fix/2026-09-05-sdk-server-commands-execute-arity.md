# Agent Note: SDK server `commands.execute` arity drift broke `session/command`

Status: implemented

English | [中文](2026-09-05-sdk-server-commands-execute-arity.zh.md)

## Problem

`HarnessSdkJsonRpcServer.command` probes the optional `commands` service through a local structural interface and calls it with three arguments: `execute(agent, line, signal)`. The real `@deepseek-ai/dsh-commands` service has taken `images` as its third parameter since composer-image routing landed (`8d9fee19f9`), making its signature `execute(agent, line, images, signal)`. The `ctx.get('commands') as CommandsService` cast erased the drift, so at runtime the `AbortSignal` bound to `images` and `signal` stayed `undefined`; the first `signal.aborted` read threw `TypeError: Cannot read properties of undefined (reading 'aborted')`, so every `session/command` call against a composed commands service failed — including `/compact` from the REPL TUI, which routes server-side slash commands through this method. The real-plugin `session/command` test was failing on master; nothing else caught the drift because no other caller uses the three-argument shape.

## Decision

Structural interfaces that mirror an optional service must track the real method signatures: the server-side `CommandsService.execute` now declares `images: readonly EncodedImageAttachment[]` before the signal, and the call site passes an empty list — the JSON-RPC wire carries no attachments for commands, and image-taking commands receive their images through `session/attach` ahead of the command. The pre-existing real-plugin test already exercises the correct arity end to end; no new test surface is required.
