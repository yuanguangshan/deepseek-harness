# Agent Note: Tolerate a stream ending without a finish_reason

Status: implemented

English | [中文](2026-08-19-pi-ai-stream-missing-finish-reason.zh.md)

## Problem

The `@earendil-works/pi-ai` OpenAI-completions stream adapter threw `Stream ended without finish_reason` when a provider streamed content to its natural end without carrying a terminal `finish_reason` (or a `[DONE]` sentinel). The opencode gateway (`https://opencode.ai/zen/go/v1`), which routes the `muse-spark-1.2` model, emits such streams: every `delta` frame ends with `finish_reason: null`, and the stream closes with a `usage` frame and no terminal marker. The harness's `dsh-llm-pi-ai` adapter (`packages/llm/llm-pi-ai/src/stream.ts`) classifies that error text as `TRANSPORT`, so every completed Muse Spark generation surfaced to dsh-repl as a mid-response disconnect ("generates a moment, then drops"). This is an upstream opencode gateway bug in how it converts a non-OpenAI model's response into an OpenAI SSE stream (opencode issue #40171, fix PR #40210) — not a defect of the model itself — so switching the wire protocol (completions vs responses) does not avoid it.

## Decision

Patch the pi-ai completions stream to treat a natural end of stream that already collected content as a normal `stop`. When the adapter reaches the terminal check with no `finish_reason` seen but non-empty content blocks (`blocks.length > 0`), it skips the `Stream ended without finish_reason` throw and pushes the normal `done` event with the default `stopReason: "stop"`. Only a terminal check with no content blocks still throws, preserving the guard against a genuinely empty response.

The patch is applied in two places so both runtimes are covered:

- **Global dsh install** (`/opt/homebrew/.../pi-ai/dist/api/openai-completions.js`): a one-line edit for the running dsh web / dsh-repl. Directly editing this compiled artifact is not durable — a reinstall or `npm update -g` overwrites it — so it is recorded here and in the README-only notes; the durable fix is the workspace patch. - **This workspace**: pnpm's official patch mechanism. `pnpm patch @earendil-works/pi-ai` → edit → `pnpm patch-commit` produced `patches/@earendil-works__pi-ai.patch`, registered as `@earendil-works/pi-ai@0.82.1` in `pnpm-workspace.yaml` `patchedDependencies`. `pnpm install` materializes the patched copy under `.pnpm/...@earendil-works+pi-ai@0.82.1_patch_hash=...`, and `packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai` resolves to it.

## Alternatives considered

**Switch the model to a wire protocol (responses) the gateway terminates cleanly.** Rejected: the opencode gateway's incomplete-SSE-lifecycle defect affects both its completions and responses conversions (users reproduced `Stream ended without finish_reason` under `openai-responses` too); changing the protocol does not fix the transport, it only moves the failure.

**Only raise the idle/timeout knobs.** Rejected: the symptom is a missing terminal event, not an idle stall; timeouts would not classify a completed-and-truncated stream as a success.

**Patch only the global install file.** Rejected as fragile: the compiled artifact is not version-controllable and a reinstall silently reverts it. The workspace pnpm patch is the durable, reviewable form and also covers repository-source development.

## Consequences

A provider stream that ends naturally after producing content is now accepted as a successful completion on both the global install and the workspace source, so `muse-spark-1.2` (and any other gateway that omits a terminal marker) works end to end. The guard for an actually empty response is preserved: a natural stream with zero content blocks still surfaces `Stream ended without finish_reason` / `TRANSPORT`. When the opencode gateway ships its SSE-lifecycle fix, this patch becomes redundant and can be removed; until then an `npm update -g` or reinstall of the global dsh package must re-apply the one-line global edit (the workspace pnpm patch survives reinstall).

## Supersedes

Partially supersedes [2026-07-22-pi-ai-transport-truncation-classification](./2026-07-22-pi-ai-transport-truncation-classification.md): a stream missing its terminal marker is no longer always classified as a `TRANSPORT` error — it is now a normal completion when content was collected, and only a `TRANSPORT` classification when the stream is empty. Both notes stay active and cross-linked.
