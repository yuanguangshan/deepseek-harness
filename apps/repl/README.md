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
| `/compact`, `/goal`, `/export` | Server-side runtime commands (compaction, goal lifecycle, session export) passed through. |
| `/context` | Estimate the session's context composition (chars/4 heuristic) with a `/compact` hint. |
| `/cost` | Session-wide token buckets priced with the same DeepSeek list prices as the per-turn line. |
| `/skills` | List skills discovered under project/user `.dsh/skills` and `.agents/skills`. |
| `/agents` | Show background subagent runs reported by the session-tree subscription. |
| `/macro add <name> <text>` / `/<name> [extra]` / `/macro rm <name>` | Store prompt macros and expand them as commands; the store lives under the memory dir. |
| `/search`, `Ctrl+R` | Fuzzy-search message lines across recent sessions and jump to a hit. |
| `Ctrl+V` | Attach the macOS clipboard image: it is stored via `session/attach` and rides the next prompt. |
| `ESC` | Interrupt a streaming turn (a new `session.cancel`). |

`@` starting a token triggers file completion. `Ctrl+C` exits the process. Long turns (≥30s by default) fire a macOS notification when they finish; `DSH_REPL_NOTIFY=off` disables it and `DSH_REPL_NOTIFY_WX=1` additionally pushes a WeChat message.

## Paging through history

The transcript scrolls inside the alternate screen under application control (the terminal's native scrollback is unavailable there):

- `[` / `]` — page up / page down (active while the editor draft is empty; typing text reclaims the keys)
- `PgUp` / `PgDn` — page up / page down; `Home` / `End` — top / bottom
- `Ctrl+Shift+↑` / `↓` — jump to the previous / next user prompt
- Trackpad/wheel scrolling (iTerm2 needs session-initiated mouse reporting allowed)

## Long-term memory

Five plain-Markdown tracks live under `~/.dsh-repl/memory` (`DSH_REPL_MEMORY_DIR` overrides the root):

- `memory` → `MEMORY.md` (cross-project long-term memory)
- `user` → `USER.md` (cross-project user profile)
- `daily` → `daily/YYYY-MM-DD.md` (per-day log, project-tagged)
- `project` → `projects/<hash>/MEMORY.md` (per-project log)
- `key` → `projects/<hash>/KEY.md` (project key facts, git-branch scoped)

The snapshot is prepended to every prompt as a memory-context block and is a no-op when empty. The store moved into its own package: [`@deepseek-ai/dsh-memory`](../../packages/companion/memory) (see the [long-term memory Agent Note](../../.agents/notes/implemented/feature/2026-08-15-repl-long-term-memory.md)).

## Architecture

The TUI adopted under the repo gates as TypeScript keeps pure logic out of terminal I/O:

- [`src/tui-repl.ts`](src/tui-repl.ts) — terminal glue: pi-tui widgets, the subscription loop, input handlers, prompt injection.
- [`src/core.ts`](src/core.ts) and [`src/session-reducer.ts`](src/session-reducer.ts) — pure logic and event→effect mapping (the only assertion-worthy core).
- [`@deepseek-ai/dsh-memory`](../../packages/companion/memory) — the pure five-track memory store and snapshot renderer.
- [`src/pet.ts`](src/pet.ts), [`src/picker.ts`](src/picker.ts), [`src/atfile.ts`](src/atfile.ts), [`src/history.ts`](src/history.ts) — supporting pure modules. `history.ts` reuses the canonical Zstandard frame scanner from [`@deepseek-ai/dsh-session-persistence-jsonl`](../../packages/session/session-persistence-jsonl) and scans a bounded prefix asynchronously.

Per the [REPL adoption note](../../.agents/notes/implemented/architecture/2026-08-14-repl-adoption-and-reducer.md), `tui-repl.ts`, `bin.ts`, and `dev.ts` are coverage-excluded as un-assertable glue, while `core.ts`, `session-reducer.ts`, and `memory.ts` sit under the per-file coverage gate.

## Development

Production runs need a build: `pnpm run build` first, then `pnpm dsh-repl <args...>`. The unit suites run with `pnpm --filter @deepseek-ai/dsh-repl run test` and are governed by the same typecheck/lint/coverage gates as the rest of the repo.

## Standalone install（单独安装为可运行插件）

`dsh-repl` is packageable as a **separate, separately-installable npm package**. The private front-end closure (`@deepseek-ai/dsh-sdk-client` and its peers) is bundled **into** `lib/bin.js` by `tsdown` (`deps.alwaysBundle`), so the tarball needs only the public `pi-tui` and `js-yaml` — it installs without a registry that carries `@deepseek-ai/*`. The **agent runtime (the `dsh-jsonrpc-agent` process and its cordis plugin closure) comes from an installed `deepseek-harness`** — it is bundled there, not in this package. `dsh-repl` locates it automatically (and lets you override the path).

### Build the standalone tarball

```sh
pnpm exec tsc -b apps/repl/tsconfig.json
pnpm --filter @deepseek-ai/dsh-repl exec tsdown --config apps/repl/tsdown.config.ts
cd apps/repl && pnpm pack
```

### Install

```sh
npm install -g ./deepseek-ai-dsh-repl-<version>.tgz
npm install -g @deepseek-ai/dsh-repl
./install.sh
```

### Connect the agent runtime

The agent runtime is part of an installed `deepseek-harness`; `dsh-repl` finds it automatically. From inside your harness tree nothing is needed; from another directory, set `DSH_REPL_ROOT` to the harness root (or override precisely with `DSH_REPL_RUNTIME` / `DSH_REPL_CONFIG`):

```sh
export DSH_REPL_ROOT=/path/to/deepseek-harness
export DSH_REPL_RUNTIME=/path/to/dsh-jsonrpc-agent/lib/bin.js
export DSH_REPL_CONFIG=/path/to/your/interactive.cordis.yml
dsh-repl
```

`DSH_REPL_RUNTIME` accepts an absolute file path (run under your Node) or a bare command name resolved from `PATH`. When nothing can be located, `dsh-repl` prints a guiding error instead of silently failing.
