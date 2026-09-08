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

## Alternatives considered

**Verify ownership only at acquisition (the shipped-before state).** Rejected: the observed corruption came from a claim taken away *after* acquisition, which an acquisition-time check cannot see.

**Re-acquire the lock before every append.** Rejected: it does not fence the loser — the writer would either contest the successor for the lock or continue under a claim it can no longer trust; the failure must stop writes, not re-contest ownership.

**Rely on OS advisory locks (`flock`/`fcntl`).** Rejected: lock semantics vary across platforms and filesystems (NFS, Windows), and the backend already owns a portable claim file carrying pid, hostname, and startedAt; the append fence checks data the backend already maintains.

**Detect the seq gap only at load.** Rejected: that reports corruption after the damage is durable and names the next loader rather than the writer that caused it; the fence fails the append that would diverge.

**Have the successor signal the dispossessed writer out of band.** Rejected: it needs an IPC channel the JSONL backend does not have and cannot assume between arbitrary processes; the lock-and-tail check detects the same condition without coordination.

## Consequences

- A dispossessed writer stops at the divergent append with a named `fenced session` error instead of durably interleaving a stale seq; the next load no longer sees a committed-region gap.
- The fenced session degrades to read-only for the life of that process; recovery is a fresh process re-reading the log, which resumes and appends normally.
- Every durable append reads the lock and verifies the tail position, adding a small filesystem cost to the write path.
- A writer that lost its lock drops the claim so teardown cannot release a successor's lock; a writer with an intact claim keeps it so `close()` still unblocks the next writer.
- Fencing is per-process and irreversible in-process: the backend cannot prove the in-memory seq cursor trustworthy again, so it never un-fences itself.
