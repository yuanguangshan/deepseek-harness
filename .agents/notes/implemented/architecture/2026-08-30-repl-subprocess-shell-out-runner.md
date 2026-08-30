# Agent Note: REPL subprocess shell-out runner and worker-file extraction

Status: implemented

English | [中文](2026-08-30-repl-subprocess-shell-out-runner.zh.md)

## Problem

Two REPL helpers (`text2card.ts`, `weixin.ts`) each hand-rolled their `spawn` plumbing: ad-hoc timeout handling, partial stdout collection, and no streaming callback — duplicated, subtly different, and untested. Separately, `tts.ts` carried the Edge-TTS worker as a 148-line string template spliced into generated Python via line surgery: the worker was invisible to editors, typecheck, and lint, and its wire behavior was pinned only by a live endpoint.

## Decision

`apps/repl/src/run.ts` owns one runner, `runCommand(bin, args, { onStdoutLine?, timeoutMs?, cwd? })`, with an explicit contract:

- It never rejects. A spawn failure resolves `{ code: -1, stdout, stderr: error.message }`; an exited child resolves its real code (or `-1` when a signal killed it), always with the full stdout and stderr.
- `onStdoutLine` fires per complete stdout line (trimmed) while the child runs; blank lines are not forwarded; an unterminated final line flushes on close.
- `timeoutMs` SIGKILLs the child at the deadline; the run still resolves instead of hanging.

`text2card.ts` (generate → rclone R2 → WeChat push) and `weixin.ts` (`runSend` → the Python send script, 30 s deadline) are now thin arg/env assemblies over the runner; `run.ts` and its contracts are unit-tested (`run.spec.ts`: streaming, blank-line skipping, unterminated tail, non-zero exit, spawn failure with and without a timeout window, cwd).

The TTS worker moved verbatim to `apps/repl/tts-worker.cjs`, a plain CommonJS file (`generateSecMsGecToken`, `xmlEscape`, `buildSsml`, plus the WSS speak loop). `tts.ts` spawns `[TTS_WORKER_FILE, voice, …]` and no longer builds source text at runtime. The wire contract — stdin text → `OK <path>` + `SIZE <n>` on stdout, `ERR <msg>` + exit 1 on failure, Sec-MS-GEC token and `speech.config`+SSML framing, one retry on close code 1006 — is pinned by `tts-worker.spec.ts` (unit tests on the token/SSML builders plus an entrypoint smoke run through `runCommand`).

## Alternatives considered

- `execFile` + promisification. Rejected: no line streaming for the status row and no hard kill on deadline; both helpers need to show progress while the child runs.
- Keep per-helper spawn code. Rejected: the two implementations already disagreed on timeouts and tail handling; a third consumer (the TTS worker smoke path) would inherit the divergence.
- Keep the worker as an inline template. Rejected: a `.cjs` asset gets syntax checking, lint, require-based unit tests, and readable diffs; the template's only advantage was single-file delivery, which the package layout never required.

## Consequences

- Shell-out behavior has one owner; a fix to tail flushing or timeout semantics lands once and applies to text2card, weixin, and any future helper.
- The runner's blank-line and `-1` conventions are test-documented, so callers can rely on them.
- `tts-worker.cjs` ships as a package file; packaging changes must keep it alongside `src/tts.ts` (it resolves via `new URL('../tts-worker.cjs', import.meta.url)`).
- The worker keeps the same external protocol as the retired inline template, so no endpoint or caller change accompanied the move.

## Related

Width/dead-code cleanup of the same batch: [the TUI unification note](../simplification/2026-08-30-repl-tui-dead-code-width-unification.md).
