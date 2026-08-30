# Agent Note: REPL runtime lifecycle hardening — blocking subscription with explicit wake

Status: implemented

English | [中文](2026-08-30-repl-subscription-wake-lifecycle.zh.md)

## Problem

The TUI's session-event subscription loop could spin or mis-report death. The old loop interleaved a polling `setTimeout` with `sub.next()`, so a live runtime burned CPU on timer ticks, and the loop's identity check (`sessionId`/`runtimeEpoch`) ran after the stream-death throw — meaning a *planned* restart that closed the client surfaced as 「会话事件流已断开」 instead of a quiet re-subscribe, while ordering between `client.close()` and the notification was left to luck.

A second lifecycle hazard: the resume picker scanned the whole session store synchronously on the UI path; two rapid `/resume` invocations could race two in-flight scans and render a stale directory listing.

## Decision

The subscription loop blocks on `Promise.race([sub.next(), wake])`. A module-scoped `wakeSubscription` resolver is the only scheduler: `notifySessionSwitch()` resolves it, the inner wait returns `undefined`, and the loop re-checks identity *before* any throw. Only a genuinely dead stream reaches the 「会话事件流已断开（运行时可能已退出）」 error; a planned restart exits the wait quietly.

Callers own the ordering rule: `newSession()`/`resumeTo()` set `sessionId`, and `restartRuntime()` bumps `runtimeEpoch`, *before* calling `notifySessionSwitch()`; `restartRuntime` also notifies before `client.close()`, so the wake path wins the race against stream death. The loop's `finally` clears `wakeSubscription` and closes the subscription, so no late `next()` rejection outlives the loop.

The resume picker (`showResumePicker`) is async behind a `resumeScanSeq` monotonic guard: it sets a 扫描历史会话… status row, awaits `listSessions()`, and only the latest-sequence invocation renders. An empty store renders an empty list plus the idle prompt; Escape hides the overlay and restores the idle status. Call sites invoke it as `void showResumePicker()`.

## Alternatives considered

- Keep a polling timer and treat any identity mismatch as death. Rejected: the timer spins while idle, and collapsing planned restarts into the death error turned every restart into a red herring users would learn to ignore.
- Re-create the subscription on every switch (close + resubscribe eagerly). Rejected: `subscribeSessionTree` is registered once per runtime connection; the wake design reuses the live subscription and only re-reads its events, so a switch costs no wire round-trip.
- Serialize resume scans with a boolean busy-flag. Rejected: a flag cannot tell the older scan that a newer one took over; the monotonic sequence makes staleness checkable in one comparison.

## Consequences

- Idle TUI cost drops to one parked promise; restarts and session switches share one quiet path, and the stream-death error regains its meaning (only real runtime death).
- The ordering rule (mutate identity → notify → close) is load-bearing and documented here; a future caller that closes first re-introduces the race it prevents.
- `wakeSubscription` is module-scoped: exactly one subscription loop may run per REPL process.
- Resume scans cannot interleave; the status row plus sequence guard give observable, deterministic picker behavior on large stores.

## Related

The async scan this picker awaits is owned by [the session-store reader note](../architecture/2026-08-30-repl-session-store-reader.md).
