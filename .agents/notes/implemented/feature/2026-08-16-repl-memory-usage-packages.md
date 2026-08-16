# Agent Note: Repl memory and usage packages

Status: implemented

English | [中文](2026-08-16-repl-memory-usage-packages.zh.md)

## Problem

The dsh-repl TUI bundled two reusable capabilities as local modules: `apps/repl/src/memory.ts` (five-track long-term memory) and `apps/repl/src/usage.ts` (opencode go + DeepSeek balance quota). Their logic is deliberately pure — injectable dependencies, no pi-tui imports, per-file 100% unit coverage — but living inside `apps/repl` made them unreachable from any other front-end or agent runtime. The TUI adoption note ([2026-08-14](../architecture/2026-08-14-repl-adoption-and-reducer.md)) gated the app and extracted the session reducer; the memory and usage stores were left as app-local modules whose reuse means copying files, which forks behavior and coverage.

## Decision

Extract both modules into a new `packages/companion/` group as standalone pure-logic libraries:

- `@deepseek-ai/dsh-memory` (`packages/companion/memory/`) — the `MemoryStore`, five-track layout, entry stamping, and `renderMemorySnapshot` prompt-injection block.
- `@deepseek-ai/dsh-usage` (`packages/companion/usage/`) — ZCode config parsing, both quota endpoints, segment rendering, and `formatUsageStatus`.

Both packages are harness-dep-free at runtime (Node built-ins only); each carries a justified-empty `./invariant` companion, and the tests moved with the sources. The TUI now imports both packages and its local copies are deleted, so there is a single source of truth. `packages/companion/` is the home for further TUI extractions (pet, tts, history) when they outgrow the app.

The `.agents/skills` catalog gained `dsh-memory` and `dsh-usage` skills: usage guidance for an agent working in this repository, pointing at the package APIs and storage layout.

A third package, `@deepseek-ai/dsh-tool-companion` (`packages/companion/tool-companion/`), registers the model-facing `memory` and `usage_status` tools over the two libraries. It is a function plugin (`name`/`inject`/`Config`/`apply`, no default) with two optional config keys (`memoryDir`, `zcodeConfigPath`) that fall back to the library defaults and their environment overrides. The tools keep host-side state on disk exactly like the TUI; the session log reconstructs every call's inputs and outputs via `tool/call` and `tool/result`. The package is mounted in the `acp-agent` and `jsonrpc-agent` examples and listed in the tool-catalog boot manifest, so its schemas appear in the generated catalog.

## Verification

The moved unit suites keep the packages at per-file 100% coverage. The REPL compiles against the packages through its project reference and the tsconfig `paths` facade. The skill catalog discovers both new names (verified via the session catalog refresh). The tool package boots through the real Loader in a `cordis.yml` composition test (config keys proven to redirect memory and quota paths), unregisters both tools on fiber disposal (HMR-safety), and keeps its `src/` at per-file 100% coverage; its `memory`/`usage_status` schemas are harvested into `docs/tool-catalog.md` by the catalog generator.

## Consequences

- The REPL and any other consumer share one memory/usage implementation; a fix or feature lands once.
- Both packages must satisfy the package gates (per-file 100% coverage, export JSDoc, invariant companion, README with Known Limitations) that `apps/repl` sources were exempt from.
- Future TUI extractions (pet, tts, history) have a home group with an established package shape.
- The model-facing tools expose host-side state (memory files, quota endpoints) that is not in the session log; `tool/call`/`tool/result` remain the reconstructable record, and the README documents the boundary.

## Alternatives considered

- **Keep the modules in `apps/repl`** — rejected: reuse would require copying, forking behavior and coverage.
- **Merge both into one package** — rejected: memory and usage have no shared surface; separate packages keep each invariant and test scope independent.
- **Place them in `packages/util/`** — rejected: util is scoped to small zero-dependency helpers; these are product capabilities with their own storage and endpoint contracts.
