# Agent Note: Cross-session long-term memory in the TUI REPL

Status: implemented

English | [中文](2026-08-15-repl-long-term-memory.zh.md)

## Problem

The interactive TUI REPL (`apps/repl/src/tui-repl.ts`) is the terminal front-end for driving an agent session. As it matures, the user repeatedly re-introduces the same standing facts — their name, their language preference, the project's key invariants — every session. Without persistence, that context is lost when a session ends, and each new session starts cold. The web product and the planned terminal front-end need a memory that survives across sessions and projects, not a per-terminal in-context crutch.

## Decision

Add a five-track, plain-Markdown long-term memory to the REPL as a self-contained, dependency-free module `apps/repl/src/memory.ts`, with a memory snapshot injected into every prompt. Port of the memory core from `dsh-memory-evolve`, adapted to the TUI (no `agent` object; project tracks key on the workspace `cwd`).

- **Five tracks**, stored under `~/.dsh-repl/memory` (override `DSH_REPL_MEMORY_DIR`):
  - `memory` → `MEMORY.md` (long-term memory, cross-project)
  - `user` → `USER.md` (user profile, cross-project)
  - `daily` → `daily/YYYY-MM-DD.md` (per-day log, project-tagged)
  - `project` → `projects/<hash>/MEMORY.md` (per-project log)
  - `key` → `projects/<hash>/KEY.md` (project key facts, branch-scoped, injected)
- **`MemoryStore`** (`memory.ts`): plain-markdown layered storage with a `\n§\n` entry separator, idempotent `[YYYY-MM-DD]` date stamps (`add()` skips exact duplicates), optional git-branch tags, branch-scoped `key`-track filtering (`[branch:main,other]` scope tags; detached HEAD conservatively passes everything), and a portable concurrent write path. Pure and fully unit-tested.
- **`renderMemorySnapshot`**: builds the markdown block prepended before the next prompt so the agent sees remembered facts across sessions. Memory/user/key cap at 12/8/12 entries, each clamped to 160 chars. Sections: `## 长期记忆（跨会话，始终遵守）`, `## 用户档案`, `## 本项目的关键记忆`.
- **TUI glue** (`tui-repl.ts`): the snapshot is prepended to `client.prompt` (a no-op when empty), project and daily logs are appended automatically on turn end, and a `/memory` command family (`remember / user / key / project / daily / clear / view`) exposes the tracks. Project identity is a stable SHA-1 of the normalized `cwd`, truncated to 12 hex chars.

## Alternatives considered

**In-memory context only** — rejected. It dies with the terminal and gives no cross-project or cross-session value; the whole point is durable persistence.

**A structured store (SQLite/JSON)** — rejected. Plain Markdown files are human-readable, viewable in any editor, and carry zero dependencies; the five tracks are naturally represented as separate files, and performance is irrelevant at these sizes.

**One global file for everything** — rejected. Project tracks would leak across workspaces and the branch-scoped key filtering would have nowhere to live; the per-project hash directory isolates state by workspace.

## Consequences

The REPL now remembers standing facts across sessions and projects, distilled from the disk-backed five-track Markdown store. The global tracks (`memory`, `user`) survive across sessions and projects; project tracks are isolated per workspace by `cwd` hash and, for the `key` track, filtered by the live git branch. Injection is a no-op until memory exists, so there is no context or latency cost for users who never use it. The module is dependency-free and fully unit-tested (30 cases in `apps/repl/tests/memory.spec.ts`), so it is governed by the same pure-logic coverage gate as the rest of the REPL core.

## Verification

`apps/repl/tests/memory.spec.ts` (30 tests) covers parse/serialize round-trips, idempotent date stamps, branch-scope filtering (including detached-HEAD conservative pass-through), cross-cwd project isolation, exact-duplicate dedup, `remove` counting, and snapshot section rendering. The full suite passes (`pnpm --filter @deepseek-ai/dsh-repl run test`); the TUI integration is executed by `pnpm run build` and exercised interactively. The snapshot text is quoted verbatim into the prompt, and its exact section headings are asserted by the spec.
