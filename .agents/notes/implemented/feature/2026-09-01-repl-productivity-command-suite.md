# Agent Note: REPL productivity command suite and the session/attach image RPC

Status: implemented

English | [中文](2026-09-01-repl-productivity-command-suite.zh.md)

## Problem

The TUI covered model switching, resume, memory, TTS, and WeChat push, but several daily-driver affordances were missing: no view of what dominates the context window before compaction, no session-wide cost rollup (only per-turn lines), no listing of the skills the runtime can see, no visibility into background subagent runs even though the protocol already reports them, no way to reuse prompt fragments, no cross-session content search, no image path that does not start with a URL, and no signal when a long turn finishes after the user switched away. Separately, `session/prompt` accepted `image` content blocks, but an SDK client had no way to store image bytes and obtain the `ImageAttachmentRef` a block requires — only the Web GUI could attach images.

## Decision

Eight pure modules under `apps/repl/src/`, each unit-tested, wired into `tui-repl.ts`:

- `/context` (`context-estimate.ts`) buckets the persisted event log into user text, system injections, assistant text, tool payloads, and everything else, applying a chars/4 heuristic (labeled as an estimate; the runtime owns the tokenizer) and a `/compact` hint.
- `/cost` (`session-cost.ts`) prices the session's token buckets with the shared `DEEPSEEK_CNY_PER_MTOK` list prices.
- `/skills` (`skills-list.ts`) scans project `.dsh/skills` + `.agents/skills` and the user-home counterparts, tolerating missing roots and unparsable `SKILL.md` files; earlier roots shadow later duplicates.
- `/agents` (`agents-panel.ts`) folds the already-subscribed `subagent.started`/`subagent.finished` notifications into run entries — no protocol change; finished-first delivery still renders.
- `/macro` (`macro.ts`) stores prompt macros in one JSON file under the memory dir (`~/.dsh-repl/memory/macros.json`); a submitted `/name` expands once (recursion-guarded) with extra input appended.
- `/search` + `Ctrl+R` (`fuzzy-search.ts`) scans the 25 most recent sessions' user/assistant lines into a capped filter picker; picking a hit resumes that session. Subsequence scoring (contiguity and word-start bonuses) is exported for callers that rank.
- Turn-completion notifications (`notify.ts`) fire a macOS toast when a turn runs ≥30s (`DSH_REPL_NOTIFY=off` disables, `DSH_REPL_NOTIFY_WX=1` additionally pushes WeChat through the existing channel).
- `Ctrl+V` (`clipboard-image.ts`) grabs the pasteboard PNG via a JXA script that reads its target path from the environment (no shell quoting of paths) and prints one machine-readable verdict.

The image path is closed with a new `session/attach` RPC: wire types in `@deepseek-ai/dsh-sdk-protocol` (`SessionAttachParams`/`SessionAttachResult` over base64 + media type → `ImageAttachmentRef`), a server handler that structurally probes the optional `attachments` service and delegates to `saveImages` (admission + limits stay owned by the attachment domain; absent service errors loudly instead of dropping images), and `HarnessClient.attachImages`. The REPL uploads clipboard bytes there and lets the refs ride the next `session/prompt` as `image` blocks ahead of the text.

`/compact`, `/goal`, and `/export` needed no work — they were already runtime-registered and passed through `client.command`.

## Alternatives considered

- Fabricating `ImageAttachmentRef`s in the REPL against the attachment store's on-disk layout. Rejected: the ref is owned by the attachment service and admission/limits/dimension checks are its job; bypassing them risks durable history the provider rejects later.
- Skipping the RPC and handing the model a file path. Rejected: a path is not a content block; vision-capable agents consume `image` blocks, and a path silently degrades to text-only.
- Fuzzy search over sessions only (titles/dirs). Rejected: the recurring need is finding *which* conversation said a thing; message-line search with resume answers that, and the picker's substring filter keeps the interaction responsive.
- Building local renderers for `/compact`, `/goal`, and `/export`. Rejected after verification: the runtime already owns all three; duplicating them would fork goal/export semantics.

## Consequences

- Context, cost, skills, agents, macros, and search are answerable without leaving the keyboard; none of them add protocol surface except the one deliberate `session/attach` method.
- `session/attach` makes SDK clients first-class image senders; any client (not just the REPL) can now reproduce the Web GUI's attachment flow.
- `run.ts` gained an `env` option (child environment override) — the clipboard JXA passes its target path that way; defaults are unchanged for existing callers.
- The notification gates are environment variables, not config files, matching how the REPL already toggles TTS and WeChat.

## Related

Runner contract this batch extends: [the REPL subprocess shell-out runner note](../architecture/2026-08-30-repl-subprocess-shell-out-runner.md).
