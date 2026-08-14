# Agent Note: Escape interrupts an active turn in the TUI REPL

Status: implemented

English | [中文](2026-08-14-repl-escape-interrupt.zh.md)

## Problem

The interactive TUI REPL (`apps/repl/src/tui-repl.ts`) streams model output over the `session.event` bus while an agent turn is running. There was no way to stop a running turn and stay in the conversation: typing was line-buffered or editor-owned, and the only global keybinding (`Ctrl+C`) exits the whole process. A user who submits a long or wrong prompt had to wait for the turn to finish (or abort the whole runtime) to continue.

## Decision

Add a `session.cancel` JSON-RPC method end to end and wire ESC to it from the TUI:

- **Wire contract** (`packages/sdk/protocol`): new `SessionCancelParams { sessionId }` and `SessionCancelResult { accepted: true }`, registered on `HarnessSdkRequestMap` as `session.cancel`. The naming mirrors the web BFF's existing `session.cancel` (`packages/host/apiproxy`), which already stops an active turn with the same semantics.
- **Server** (`packages/sdk/server`, the `dsh-jsonrpc-agent` runtime the REPL drives): a new `cancel()` handler resolves the owning agent and calls `agent.cancel({ kind: 'user' }, { keepInbox: true })`, preserving pending inbox work so queued follow-ups survive the interrupt. `handleRequest` routes `session/cancel` to it. Unknown sessions reject (the `prompt`/`command` routes share `getOrCreateSession`).
- **Client** (`packages/sdk/client`): a typed `cancel(sessionId)` that issues `session/cancel` and confirms `accepted`.
- **TUI** (`apps/repl/src/tui-repl.ts`): the global input listener now, on `escape` when a turn is streaming (`busy`), issues `client.cancel` once, shows an "中断中…" status, and returns `{ consume: true }` so the key is not re-delivered to the editor. When idle, escape keeps falling through to the editor (autocomplete dismissal etc.). On `turn/end` a user-initiated interrupt (tracked by an `interruptRequested` flag carried on the session reducer state) no longer renders as a red "turn 异常"; the existing turn finish resumes the editor for the next prompt.

## Alternatives considered

**A front-end-only fake stop** — rejected. Stopping the *display* while the runtime keeps running would misrepresent state and let the backend keep spending tokens/tools; the interrupt must reach the agent loop.

**Reusing the web BFF `session.cancel`** — rejected. The REPL drives the standalone `dsh-jsonrpc-agent` SDK runtime over stdio JSON-RPC, not the `apiproxy` HTTP facade, so the method had to be added to the SDK wire protocol.

**Ctrl+C as the interrupt key** — rejected. Ctrl+C is the established "exit the process" binding in both REPL implementations; reusing it for interrupt is surprising and cannot exit while streaming.

## Consequences

A streaming turn can be stopped mid-flight from the TUI and the session stays usable for the next prompt. The interrupt is a user `kind` cause, surfaces a `turn/end` with an `aborted` reason, and keeps the inbox, so a prompt submitted before the cancel still runs afterwards. The web app has its own interrupt semantics and is not changed; the TUI is the only terminal front-end (the line-mode REPL was removed when the TUI moved to TypeScript).

`command()` was tightened while touching this file: it probes the optional `dsh-commands` service through a structural `CommandsService` type and drops the redundant `agent === undefined` guard (the handle's `agent` is non-optional), clearing the pre-existing `no-unsafe-*`/`no-unnecessary-condition` lint without adding a hard dependency on `dsh-commands`.

## Verification

`packages/sdk/server/tests/server.spec.ts` covers `session.cancel`: the direct `cancel()` receipts acceptance and the JSON-RPC dispatch route both assert `agent.cancel` was invoked with `{ kind: 'user' }` and `{ keepInbox: true }`. The SDK client/server/protocol suites still pass; the TUI change is executed by `pnpm run build` and exercised interactively.
