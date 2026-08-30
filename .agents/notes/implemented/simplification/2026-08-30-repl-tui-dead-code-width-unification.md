# Agent Note: REPL TUI dead-code removal and width-measuring unification

Status: implemented

English | [中文](2026-08-30-repl-tui-dead-code-width-unification.zh.md)

## Problem

The REPL's TUI helpers carried duplicated and dead measuring/rendering logic inside `apps/repl/src`:

- `core.ts` exported `formatStatsLine` and `packStatFields`, a joined-line rendering of the stats that no caller used — every consumer renders `formatStatsFields` fields directly. It also exported `visibleTextWidth`, a hand-rolled visible-width counter parallel to the `visibleWidth` that pi-tui already provides and that the TUI's other widgets use, so two width truths could disagree on CJK/emoji glyphs.
- `whale-banner.ts` shipped `renderWhaleBanner` and `whaleDot`, startup-banner code with no caller since the working whale moved to the status row; in partition-mode coverage runs they were both dead and uncovered.
- Behavior worth keeping lived inline in the ~2000-line `tui-repl.ts`: the whale swim state machine, the pet mood decay, the greeting string (seven copies), the command list (a hand-maintained array that had already drifted — `reload`, `weixin`, and `wx` had handlers but no completion), and `dev.ts` restarted on every event with no debounce.

## Decision

Deletions: `formatStatsLine`, `packStatFields`, and `visibleTextWidth` are gone from `core.ts`; `renderWhaleBanner` and `whaleDot` are gone from `whale-banner.ts`. `status-bar.ts` and `whale-banner.ts` measure every string with pi-tui's `visibleWidth`, making it the single width authority for the REPL.

Extractions, each a pure module function with its own focused suite: `stepWhaleSwim` (whale-banner.ts) advances the swim one tick — edge clamps, lap bookkeeping, live-thinking repeat, quip rotation; `stepPetMood` (pet.ts) applies mood decay then doze sequentially so one step can land `sleeping`; the idle greeting is one `IDLE_STATUS_TEXT` constant rendered by `showIdleStatus()`; `allCommands` is derived from `commandCompletions` + the server command list + the documented subcommand phrases, deduplicated and length-sorted. `dev.ts` uses one `fs.watch(srcDir, { recursive: true })` filtered to `.ts` files with a 400 ms debounce.

## Alternatives considered

- Keep `visibleTextWidth` and alias pi-tui to it. Rejected: pi-tui's counter is the one the editor and overlays already agree on; a second implementation reopens glyph-width drift.
- Derive `allCommands` by scraping the submit handler's switch. Rejected: the completions table is already the source of truth for what completes; the derivation only adds the server-provided commands and subcommand phrases.
- Cover `renderWhaleBanner` with a startup-snapshot test instead of deleting. Rejected: the whale renders through `renderWhaleHalfBlock` everywhere; a second renderer would need its own golden file to stay honest.

## Consequences

- `history.ts`, `run.ts`, `status-bar.ts`, and `whale-banner.ts` sit at 100% statement/branch/function/line coverage in the focused suite; the pure extractions made the animation rules assertable without a terminal.
- `formatStatsFields` gained direct tests (counts, durations, cache/tokens, ctx clamp, injected styles) instead of being covered incidentally through the deleted line renderer.
- New commands must be added to `commandCompletions` (or the subcommand list) rather than a second array; the derived `allCommands` cannot drift from what completes.

## Related

The shell-out channel consolidation is recorded in [the subprocess runner note](../architecture/2026-08-30-repl-subprocess-shell-out-runner.md).
