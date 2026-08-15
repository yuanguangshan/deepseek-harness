# `@deepseek-ai/dsh-repl`

English | [中文](README.zh.md)

An interactive TUI REPL front-end for a DeepSeek Harness JSON-RPC agent runtime. It drives the bundled `dsh-jsonrpc-agent` over stdio, streams assistant text, thinking, and tool cards live, and keeps an agent session's transcript and cross-session memory. It is the terminal front-end the product replaced the removed `dsh-tui` decision with.

## Entry

The binary is `dsh-repl`, bundled from `lib/bin.js` by `apps/repl/tsdown.config.ts` ([`src/bin.ts`](src/bin.ts) is the thin entry, `/* v8 ignore file */`). From a built checkout, run from the repository root (the script delegates to `apps/repl`):

```sh
pnpm run build
pnpm dsh-repl
```

Launching opens the most recent persisted session if one exists, otherwise a fresh one. `/new` starts a fresh session and `/resume` switches to a historical one (works across workspaces with a `cwd` handoff).

## Commands

| Input | Purpose |
|---|---|
| `/model` | Switch model via a searchable filter box, or reload the runtime. |
| `/resume` | Reopen a historical session (cross-workspace with `cwd` handoff). |
| `/new` | Start a fresh session. |
| `/memory` | Show the memory snapshot that would be injected next. |
| `/memory remember <fact>` | Add a cross-session long-term memory entry. |
| `/memory user <profile>` | Add a user-profile entry. |
| `/memory key <fact>` | Add a project key entry (git-branch scoped). |
| `/memory project <log>`, `/memory daily <log>` | Append a project or daily log entry. |
| `/memory clear <all\|memory\|user\|key\|project\|daily>` | Clear a track. |
| `ESC` | Interrupt a streaming turn (a new `session.cancel`). |

`@` starting a token triggers file completion. `Ctrl+C` exits the process.

## Long-term memory

Five plain-Markdown tracks live under `~/.dsh-repl/memory` (`DSH_REPL_MEMORY_DIR` overrides the root):

- `memory` → `MEMORY.md` (cross-project long-term memory)
- `user` → `USER.md` (cross-project user profile)
- `daily` → `daily/YYYY-MM-DD.md` (per-day log, project-tagged)
- `project` → `projects/<hash>/MEMORY.md` (per-project log)
- `key` → `projects/<hash>/KEY.md` (project key facts, git-branch scoped)

The snapshot is prepended to every prompt as a memory-context block and is a no-op when empty. See the [long-term memory Agent Note](../../.agents/notes/implemented/feature/2026-08-15-repl-long-term-memory.md); the pure store and render live in [`src/memory.ts`](src/memory.ts).

## Architecture

The TUI adopted under the repo gates as TypeScript keeps pure logic out of terminal I/O:

- [`src/tui-repl.ts`](src/tui-repl.ts) — terminal glue: pi-tui widgets, the subscription loop, input handlers, prompt injection.
- [`src/core.ts`](src/core.ts) and [`src/session-reducer.ts`](src/session-reducer.ts) — pure logic and event→effect mapping (the only assertion-worthy core).
- [`src/memory.ts`](src/memory.ts) — pure five-track memory store and snapshot renderer.
- [`src/pet.ts`](src/pet.ts), [`src/usage.ts`](src/usage.ts), [`src/model-picker.ts`](src/model-picker.ts), [`src/atfile.ts`](src/atfile.ts), [`src/history.ts`](src/history.ts) — supporting pure modules.

Per the [REPL adoption note](../../.agents/notes/implemented/architecture/2026-08-14-repl-adoption-and-reducer.md), `tui-repl.ts`, `bin.ts`, and `dev.ts` are coverage-excluded as un-assertable glue, while `core.ts`, `session-reducer.ts`, and `memory.ts` sit under the per-file coverage gate.

## Development

Production runs need a build: `pnpm run build` first, then `pnpm dsh-repl <args...>`. The unit suites run with `pnpm --filter @deepseek-ai/dsh-repl run test` and are governed by the same typecheck/lint/coverage gates as the rest of the repo.
