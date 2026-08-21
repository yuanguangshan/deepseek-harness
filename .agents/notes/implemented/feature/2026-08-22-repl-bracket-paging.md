# Agent Note: REPL transcript paging with [ and ] on an empty draft

Status: implemented

## Problem

The REPL renders in pi-tui's alternate screen (`TuiAltScreen`), where the terminal's native scrollback does not exist: iTerm2 trackpad gestures, the scrollbar, Cmd+↑, and Shift+PageUp have nothing behind them to scroll. The library already wires PageUp/PageDown/Home/End/Ctrl+Shift+↑↓ to the primary ScrollView before the focused editor sees them, but a MacBook Air has no PageUp/PageDown keys, and the binding was undiscoverable — users read "cannot page back through history".

Two further facts came out of tracing the input path:

1. The app-level input listener swallowed every kitty-protocol CSI-u sequence it did not recognize as Ctrl+letter (`ESC[NN;<mods>u`), including modifier-carrying navigation keys that pi-tui's `matchesKey` can parse (e.g. xterm shift+PageUp `\x1b[5$`, kitty numpad-encoded `\x1b[57421u`).
2. `Ctrl+[` cannot serve as a paging fallback: it IS Escape (0x1b), already bound to turn interruption.

## Decision

Plain `[` / `]` page up/down while the editor draft is empty, implemented as the pure `bracketScrollAction(data, editorEmpty)` in `core.ts`; the TUI glue maps the result to one page scroll (`terminal.rows - PAGE_SCROLL_OVERLAP_LINES`, matching pi-tui's own paging overlap of 4). An empty input box signals reading intent; once any text exists the keys insert literally again, which is the built-in conflict fallback for text entry. Single-character matching inherently ignores bracketed paste blobs.

The kitty swallow branch now consumes only key-release events and modifier-less codepoint presses (`CSI NN u` / `CSI NN;1…u`, the IME noise the original guard targeted); sequences carrying real modifiers fall through so upstream scroll/navigation bindings stay reachable. The welcome banner names the paging keys.

`Ctrl+[` was rejected because it is physically indistinguishable from Escape; `Ctrl+]` stays with the editor's jump-forward binding.

## Verification

`tests/core.spec.ts` pins the gate: `[`/`]` page only when the draft is empty, non-single-char sequences (paste) never page. A synthetic harness over the real dispatch chain confirmed `[` scrolls one page through `handleTerminalInput`, `]` returns, and with a non-empty draft `[` lands in the editor untouched. Package vitest suite green (110 tests); `tsc -b` clean; `lib/bin.js` rebuilt through tsdown.

## Alternatives considered

Ctrl-based paging fails on `Ctrl+[`=Escape. Always-on `[`/`]` eats the first bracket of a literal "[…]" message. Main-screen rendering (`TuiMainScreen`) would restore native scrollback but its contract intentionally lacks the viewport layout (pinned status bar, ScrollView regions) this REPL is built on.
