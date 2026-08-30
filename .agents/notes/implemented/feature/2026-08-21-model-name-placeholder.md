# Agent Note: Composer placeholder shows current model name

Status: implemented

English | [中文](2026-08-21-model-name-placeholder.zh.md)

## Problem

The composer's textarea placeholder displayed "Message the agent" (en) / "给智能体发消息" (zh) regardless of which model the session was addressing. Users switching between models (e.g. deepseek-v4-flash, ox-alpha-free, mimo-v2.5) received no visual confirmation of the active route in the input area — only the ModelSelect trigger above the bar showed the selection. In multi-model workflows this created ambiguity about which model would process the next prompt.

## Decision

A new session-projection key `modelSelection` carries the provider/model route the session's next request will use, folded from the durable `request/context` event records (the same fact the agent loop logs when the route or capacity changes). The key is registered in `apiproxy` alongside the existing `sessionListMetadata` and `imageLimits` units; the consumer is `InputBar` in `ui-conversation`, which reads it through the standard `useProjection` hook.

**Host side (apiproxy):**
- `ModelSelectionRoute` type (`{ provider, model }`) added to `api/sessions.ts` and merged into `SessionProjectionMap` and `SessionProjectionStateMap` (nullable until the first `request/context` is logged).
- `modelSelectionProjectionSchema` (zod, nullable) added to `api/sessions.schema.ts`.
- Registration in `api-proxy.ts`: state is `null` before any request; `apply` captures `event.data.{ provider, model }` from each `request/context` event; `wire.view` returns the state directly (null when no request has been logged). `stateVersion: 1`.

**Client side (ui-conversation):**
- `locales.ts`: new key `'placeholder.model': '给 {model} 发消息'` / `'Message {model}'`.
- `InputBar.tsx`: `useProjection('modelSelection', sel => sel?.model)` resolves the model name; the default placeholder branch uses `t('placeholder.model', { model })` when the projection is present, falling back to `t('placeholder.default')` when absent (fresh session or no projection capability).

**Data flow:** `selectModel` RPC → next loop iteration → `request/context` event appended (route change detected) → projection fold pushes new value → client frame → InputBar re-renders. The gap between `selectModel` and the next `request/context` is one loop step; the ModelSelect trigger already shows the new selection immediately via its own RPC-based store.

## Alternatives considered

**Read selectionFor memory state via projection live-view.** Rejected: `imageLimits` uses this pattern only because it is boot-constant (the sanctioned exception). Model selection changes mid-session; a live-view would break the fold's observational purity and the persisted-cache contract.

**Append a synthetic event on selectModel success.** Rejected: introduces a second writer for `request/context`-like records, complicating the agent loop's own diff-before-append logic and the session-log invariants without a clear ownership boundary.

**Cross-package store sharing (ui-conversation reads ui-model-selection's store).** Rejected by the client AGENTS.md cross-package import prohibition. The projection channel is the sanctioned route for this class of live host-derived data.

## Testing

- `input-bar.client.spec.tsx`: three new cases — model name shown when projection present, generic fallback when absent, plan-mode placeholder still outranks model name. All 80 tests pass.
- `typecheck` passes (host + client faces).
- `api-proxy-projections.spec.ts` has 8 pre-existing failures (unrelated `test/last-user` key); no regressions from this change.

## Consequences

The composer placeholder names the model the next prompt will reach, and the ModelSelect trigger above the bar no longer carries that fact alone. The `modelSelection` projection key is available to any future client that needs the session route; fresh sessions and hosts without the projection still get the generic placeholder. The 8 pre-existing `api-proxy-projections.spec.ts` failures remain tracked and untouched.
