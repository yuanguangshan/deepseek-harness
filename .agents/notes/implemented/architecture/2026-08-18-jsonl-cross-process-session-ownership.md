# Agent Note: Cross-process session ownership locks in the JSONL backend

Status: implemented

English | [中文](2026-08-18-jsonl-cross-process-session-ownership.zh.md)

## Problem

The JSONL backend's write path assumes one live writer per session: the seq cursor and the per-id serialization chain both live in the owning process (`PersistenceCoordinator`). The pre-release README documented this as a limitation ("another backend instance or process must not write the same session") and enforced nothing.

Two front-ends share one session root in real deployments: `dsh web` (its own host process) and `dsh-repl --web-sessions` (spawning its own runtime child). When both resumed the same session, each process continued seq from its own in-memory cursor, interleaving batches in one append-only file. The result was duplicate and gapped seqs — logs that fail `events[i].seq === i` on load and can refuse the entire `dsh web` boot (`corrupt Zstandard session log`). External workarounds (a CoW copy-plus-merge coordinator script, an `shlock` patch injected into the installed `dsh`) made it worse: the merge rewrote whole files non-atomically with a naive magic-scan frame splitter, and the patch covered only one of the two writers.

## Decision

The JSONL backend now holds an explicit cross-process write-ownership lock per session:

- **Lock file**: `.lock` inside the session's own directory, created with O_EXCL, containing `{ pid, hostname, startedAt }`. The session directory is reserved for session-owned artifacts and discovery reads only the fixed transcript filename, so the lock is invisible to listing/loading.
- **Acquisition point**: `appendBatch` and `commitRepair` (the backend's only mutating hooks) acquire before the first durable write of the id. Acquisition is idempotent per process (same pid re-claims its own record).
- **Release**: the backend's `close()` hook — which the coordinator's dispose effect awaits *after* the quiescence drain — releases every held lock. A crashed owner leaves the file; the takeover rule handles it.
- **Refusal**: a live same-host owner (`process.kill(pid, 0)`; EPERM counts as alive) fails loud: `session "id" is owned by another writer (held by live pid N); stop that writer or resume after it exits`. The message names the pid so the user can find the process.
- **Stale takeover**: a same-host dead pid is superseded after a warning. A foreign hostname cannot be probed and stays authoritative until removed on that host — failing loud beats silently corrupting a possibly-NFS-shared root.
- **Unreadable lock** (torn payload from a crash mid-write): treated as naming no owner; removed and retried.
- **Reads never block**: `load`/`inspect`/`list`/`readFrom` acquire nothing. A session held by another process is fully readable — only writes refuse. This keeps web-side browsing of a TUI-held session working.

The lock is JSONL-backend-local by design: the `PersistenceBackend` seam stays lock-free, SQLite gets writer exclusion from its own database layer, and a third-party backend keeps its own concurrency rules. Same-process double-mounting is unchanged: the coordinator's in-process owner rules already own that case, and the lock's same-pid idempotency matches.

## Alternatives considered

- **Locking in the coordinator (`dsh-session-persistence`)** — rejected: the seam would then dictate storage-side lock layout to backends (SQLite needs none; it has transactions), and the lock file's location is a JSONL on-disk-layout decision.
- **Advisory `flock`** — rejected: locks vanish with the process (good) but cannot survive inspection ("who owns this?"), and NFS portability is worse than a payload-bearing file.
- **Socket/port-based ownership** — rejected: heavier than the problem; a single-machine deployment pattern is the current consumer.
- **Fail-loud without takeover** — rejected: a crashed owner would permanently wedge the session until manual deletion; same-host takeover is safe (the dead pid cannot write again).

## Consequences

One new module (`src/ownership.ts`, bundled into `lib/index.js`), acquisition in the two mutating hooks, a `close()` hook, and a process-bound spec (`tests/ownership.spec.ts`) covering create/idempotence/live-refusal (real spawned sleeper pid)/dead-takeover/foreign-host/unreadable-payload/EPERM, plus real second-process refusal and post-dispose handoff via a tsx-driven child (`tests/fixtures/second-writer.ts`). The README limitation bullet now names the mechanism instead of a bare warning. The TUI/web shared-root workflow keeps its behavior (shared root, resume after the other exits) but loses its corruption mode.
