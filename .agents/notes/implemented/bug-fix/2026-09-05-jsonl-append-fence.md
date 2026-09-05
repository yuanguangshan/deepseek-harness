# Agent Note: Append fence for JSONL session ownership

Status: implemented

English | [中文](2026-09-05-jsonl-append-fence.zh.md)

## Problem

The JSONL backend's cross-process ownership lock guarded only acquisition: a claim in the backend's map short-circuited every later `ensureOwnership` call, and `appendLines` appended at EOF blind to what the file actually contained. When a second process superseded the lock between two appends of the first writer — observed in production as the WeChat bridge runtime's interrupted turn draining a late tool result after the web runtime had already resumed the session and appended its boot events — the dispossessed writer appended its stale-seq events after the successor's, producing a seq gap that only surfaced on the next load as `corrupt session log: seq gap in committed region`. The lock correctly stopped fresh acquisitions against a live owner, but nothing fenced the writer whose claim had been taken away after the fact.

## Decision

The backend verifies two invariants before every durable append, not just at acquisition:

- **Lock intact**: the `.lock` file still records exactly this process's claim (pid, hostname, startedAt — `verifySessionOwnership`). A replaced or vanished lock means a successor (or an operator) intervened.
- **Tail current**: the log file ends at the byte this backend last wrote or observed (seeded at acquisition, advanced by `materialize`/`appendLines`/`repair`). Foreign bytes under an intact lock are a concurrent writer the lock alone cannot see.

Either divergence fences the session for the life of the process: the triggering append fails with `fenced session "<id>" (…)` and every later durable write refuses immediately — the in-memory seq cursor can no longer be trusted, so the only way forward is a fresh process re-reading the log (a fenced-then-reopened session resumes and appends normally). A fenced writer whose lock was lost drops the claim so teardown cannot release the successor's lock; a fenced writer with an intact claim keeps it so `close()` still unblocks the next writer. Reads and listing stay available on fenced sessions — the dispossessed process degrades to read-only, matching the ownership contract's read paths.
