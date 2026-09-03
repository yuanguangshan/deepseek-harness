# Agent Note: REPL session governance and copy suite

Status: implemented

English | [中文](2026-02-20-repl-session-governance-copy-suite.zh.md)

## Problem

The productivity suite covered reading and searching history, but the daily loop still had gaps: copying the last reply meant selecting text in the terminal; there was no way to see the working tree's unstaged diff or undo accidental edits from inside a turn; disk images could only come from the clipboard; context pressure surfaced only through the `/context` command the user had to remember to run; deleting a stale session required finding its directory on disk; titles regenerated no matter how good the automatic one was; and no command answered "is this machine's environment even complete?" before blaming the model.

## Decision

Seven additions to `apps/repl/src/`, each a pure unit-tested module wired into `tui-repl.ts`, plus one new session package:

- `/copy` + `Ctrl+Y` (`clipboard-copy.ts`) copies the last assistant reply — the first fenced code block when one exists (degenerate double-fence bodies are taken verbatim), else the full text — through the shell-out runner (`pbcopy` first, OSC 52 fallback), reusing the terminal-clipboard runner contract.
- `/diff` and `/revert` (`git-ops.ts`) run `git diff --no-color` and `git checkout -- .` in the REPL cwd through an injectable git runner; exit ≤ 1 is treated as ok-with-differences, anything else reports `git 退出码 N` with stderr. `/revert` sits behind a `ConfirmDialog` and discards all unstaged changes.
- `/doctor` (`doctor.ts`) probes the runtime binary, `git`, `rg`, and `zstd` on `PATH` plus the `DEEPSEEK_API_KEY`/gateway-key environment, printing an `ok/warn/fail` table. The platform lookup and PATH resolution are injectable for tests.
- Disk-image attachments (`atfile.ts` `extractImageMentions`) parse `@path/to.png` and `@"path with spaces.png"` out of a submitted prompt, expand `~`, resolve relative paths against the REPL cwd, read the bytes, upload via the existing `session/attach` RPC, and let the refs ride the next prompt; non-image and nonexistent paths stay literal text.
- Context pressure (`core.ts` `contextPressure`) turns the chars/4 estimate into a 75% yellow / 85% red status-bar warning with a one-shot `/compact` hint at critical, reset on session switch.
- `/resume` deletion: the session picker takes an optional delete handler; the delete key (`\x1b[3~`/Ctrl+D) opens a `ConfirmDialog` and removes the encoded session directory (`history.ts` `deleteSessionDir`, `missing` when already gone) without touching siblings.
- `/rename` (new `packages/session/command-title`) registers one global command delegating to `ctx.sessionTitle.rename()`; empty input returns usage, domain validation errors become usage errors, and unexpected failures propagate. The interactive example composition mounts the plugin after the title service.

## Alternatives considered

- OSC 52 only for `/copy`. Rejected: iTerm2's OSC 52 handling is opt-in per session, while `pbcopy` is always present on the macOS install base; the existing fallback chain already encodes this order.
- `git stash` semantics for `/revert`. Rejected: stashing keeps the changes reachable but silently reshuffles the working tree the user asked to clean; a typed confirmation plus `checkout -- .` does exactly what the prompt says.
- A separate `/rm <n>` command for session deletion. Rejected: the picker already enumerates sessions with full context on screen; a delete affordance in place avoids a two-step id round-trip.
- A REPL-side title pin (store the title in REPL state, suppress display of automatic ones). Rejected: the title lives in the session log and the runtime owns it; a client-side pin would fork with every other client reading the same session.

## Consequences

- The common cleanup verbs — copy, diff, revert, delete, rename — are one command each, without leaving the keyboard or shelling out manually.
- Image attachment now covers every source (clipboard, disk path, quoted paths with spaces) through the same `session/attach` path, so admission and limits stay in one place.
- Context warnings are ambient: the status bar speaks before `/context` is needed, and the critical hint fires once per session instead of nagging every turn.
- `dsh-commands` gains a session-title example dependency; bare plugins in cordis.yml must stay in the resolver manifest, which `verify-cordis-config` enforces.

## Related

Runner contract reused by `/copy`: [the REPL subprocess shell-out runner note](../architecture/2026-08-30-repl-subprocess-shell-out-runner.md). The prior productivity batch this extends: [the REPL productivity command suite note](2026-09-01-repl-productivity-command-suite.md).
