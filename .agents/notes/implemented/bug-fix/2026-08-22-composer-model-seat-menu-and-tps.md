# Agent Note: Composer model seat — containment-trapped menu and lifetime-average tps

Status: implemented

## Problem

Two composer regressions around the model seat:

1. Clicking the model chip popped a rectangle the width of the trigger and ~10px tall instead of the menu. Commit bf05cc27de moved the phone-width menu onto `position: fixed` centering under `@container (max-width: 480px)`, asserting "no ancestor on this path creates a containing block". That premise is false twice over: the nearest query container for ModelSelect's rules is InputBar's `.row`, which declares `container-type: inline-size` (for PermissionSelect's anonymous queries), and per css-contain-3 an inline-size container carries layout containment — making THAT row the containing block for any fixed descendant. The centered dialog resolved against the toolbar row's box and collapsed; because `.row` can be ≤480px on half-snapped desktop windows too, the trap was not phone-only.
2. The "live" tps badge computed `decodeTokens / decodeMs` from the `sessionStats` projection. Those figures are whole-log sums folded at step completion, so the quotient is a lifetime average that barely moves after a few turns.

## Decision

The menu returns to the absolute flyout (`right: 0; bottom: calc(100% + 8px)` relative to `.root`) at every width. The base rule already caps the card by `calc(100vw - 32px)` with its right edge ~16-24px from the viewport edge, so it fits from 320px phones up without any fixed positioning. A comment on `.menu` records the containment trap so the fixed-centering idea stays dead.

The badge reads the NEWEST assistant node's own rate straight from the ready-made per-step fields — `assistantStepReading(node)` in turn-metrics.ts exposes each step's `decodeMs` and provider `outputTokens`, the same readings StatsLine and the turn footer fold. A `useSession` selector walks nodes back-to-front and divides that step's output tokens by its decode seconds; a newest step lacking both figures renders nothing rather than a stale reading. No client-side sample bookkeeping exists. ContextMeter and the model seat swapped places in the trailing group (context left of model) per product preference.

## Verification

`input-bar.client.spec.tsx` feeds assistant-node fixtures through the bench snapshot: two settled steps render `425 tok/s` from the NEWEST step while the older step's 150 tok/s must not win, an empty log renders nothing, and a newest step without recorded timing/usage hides the badge instead of showing stale numbers. Suite green (82), package sweep green except three pre-existing StatsLine failures reproduced on the baseline without this diff. Both packages rebuilt (`tsc -b`, tsdown) and the served `/plugins/*/client.js` bundles verified byte-identical to disk.

## Alternatives considered

Portal-to-body would make `fixed` truly viewport-resolved but moves the menu outside `rootRef`, forcing outside-click and focus-leave close logic through an extra ref for no UX gain. Centering within the hijacked containing block was rejected: the row is 40px tall, so the card straddles the screen edge.
