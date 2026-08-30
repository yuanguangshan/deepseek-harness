# Agent Note: REPL session-store reader on the canonical zstd scanner

Status: implemented

English | [中文](2026-08-30-repl-session-store-reader.zh.md)

## Problem

`apps/repl/src/history.ts` carried its own copy of the zstd frame scanner for reading persisted session logs, duplicating `scanZstdFrames` from `@deepseek-ai/dsh-session-persistence-jsonl`. Two scanners could disagree about what constitutes a valid frame — a corrupt or torn log would then scan differently in the REPL than in the persistence package. At the same time the module's synchronous full-store scans (`listAllSessions` walking every workspace, `readdir` per session) blocked the TUI's event loop, and `findTitle` decoded every frame it met regardless of budget.

Importing the canonical `src/format.ts` wholesale was not an option: it exports the encoders next to a `cordis` import, and the REPL's standalone bundle must not pull cordis in. The local mirrors (`encodeSessionId`, `projectKey`) were therefore necessary but unchecked — a canonical format change would silently split the session store into two incompatible directory layouts.

## Decision

`history.ts` imports `scanZstdFrames` from `@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts` — that module has no cordis dependency, so the bundle stays clean — and drops its own scanner. The frame-scan authority is now single.

The `encodeSegment`/`projectKey` mirrors stay local, and a drift-guard test imports the canonical `format.ts` (test-only, never in the runtime bundle) and asserts both mirrors agree on segment encodings (`a/b`, emoji, `.`, `..`, `x~y`, spaces) and project keys (`~` in paths, `//`, `/:`).

Listing is async and bounded: `listSessionsIn`/`listAllSessions`/`listSessions` await their directory reads, `yieldToEventLoop()` (a `setImmediate` promise) separates workspace scans so the TUI stays responsive, and the `tui-repl` resume picker runs the scan behind a sequence guard with a 扫描历史会话… status row — empty results and cancellation fall back to the idle prompt. `findTitle` skips a frame once `consumed >= budget` before decoding, so a large log cannot force unbounded decompression; its decode-failure path stops the scan rather than throwing.

## Alternatives considered

- Import canonical `format.ts` and accept the cordis edge. Rejected: the REPL bundle is a standalone TUI; pulling the harness plugin runtime in for two string functions is the wrong dependency direction.
- Copy `scanZstdFrames` into history.ts like the encoders. Rejected: the scanner is scan-behavior authority (what frames exist, where they end); a divergent copy produces different reads of the same file, not just a different encoding of a new name.
- Decode frames lazily per event request. Deferred: `readSessionEvents` is called on explicit resume/inspect paths; the budget already caps the title scan, and per-frame caching adds state without a measured cost to erase.

## Consequences

- Corrupt/torn logs scan identically in the REPL and in the persistence package; the tolerant-reader behavior (skip junk lines, stop at a failed decompression) sits on top of one scanner.
- The mirrors cannot drift silently: the drift-guard test fails the suite when the canonical encoder changes, pointing at exactly which segment or key diverged.
- Resume no longer freezes the UI on large stores; a second open of the picker cannot race an older in-flight scan (sequence guard).
- `scanZstdFrames` throwing on corrupt magic remains part of its contract; callers that must not throw wrap it (`readSessionEvents` re-raises by design — the tolerant reader lives at the UI boundary).

## Related

Runner/worker consolidation: [the subprocess runner note](./2026-08-30-repl-subprocess-shell-out-runner.md); TUI cleanup: [the unification note](../simplification/2026-08-30-repl-tui-dead-code-width-unification.md).
