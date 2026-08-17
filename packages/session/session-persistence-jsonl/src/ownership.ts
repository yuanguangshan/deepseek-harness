/**
 * Cross-process per-session ownership locks for the JSONL backend.
 *
 * The JSONL log's seq cursor and serialization chain live in the owning
 * process, so two processes appending the same session interleave batches and
 * corrupt the contiguous-seq contract. A durable ownership lock fails that
 * second writer loud before any byte reaches the log.
 *
 * The lock is a `.lock` JSON file created with O_EXCL inside the session's own
 * directory (never discovered as a log; `listSessionDirs` reads directories
 * only). It records `{ pid, hostname, startedAt }`. A stale lock — its pid no
 * longer alive on the same host — is taken over after a stale-observed notice;
 * on a foreign hostname no liveness probe is possible, so the lock stays
 * authoritative until its owner's host is back (or it is removed manually).
 * The backend creates the lock at the first durable write and removes it in
 * its `close()` teardown after the quiescence drain; a crashed owner leaves
 * the file for the takeover rule.
 *
 * @module dsh-session-persistence-jsonl/ownership
 */

import { open, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'

/** The lock-file payload: who owns the session's write path. */
export interface SessionOwnershipRecord {
  /** Owning OS process id. */
  pid: number
  /** Owner's hostname; liveness probing only applies on the same host. */
  hostname: string
  /** Lock-creation time, Unix epoch milliseconds. */
  startedAt: number
}

/** Whether an OS process is alive (signal 0). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    // EPERM: the process exists but belongs to another user — still alive.
    return code === 'EPERM'
  }
}

/** Parse a lock payload, or `undefined` for anything unreadable/non-numeric. */
async function readOwnership(path: string): Promise<SessionOwnershipRecord | undefined> {
  let text: string
  try {
    const handle = await open(path, 'r')
    try {
      text = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
  try {
    const value = JSON.parse(text) as Partial<SessionOwnershipRecord> | null
    if (value !== null && typeof value.pid === 'number' && typeof value.hostname === 'string'
      && typeof value.startedAt === 'number') {
      return { pid: value.pid, hostname: value.hostname, startedAt: value.startedAt }
    }
  } catch {
    /* fall through: unreadable lock content is treated as absent */
  }
  return undefined
}

/**
 * A cross-process write-ownership claim over one session directory.
 * Construct via {@link acquireSessionOwnership}.
 */
export interface SessionOwnership {
  /** The lock file path (inside the session directory). */
  readonly path: string
  /** The record now on disk. */
  readonly record: SessionOwnershipRecord
}

/** Diagnostics carried by an ownership refusal. */
export interface OwnershipRefusal {
  /** The owner record found in the lock file (or the stub when unreadable). */
  readonly owner: SessionOwnershipRecord
  /** Why the owner could not be superseded. */
  readonly reason: 'live-owner' | 'foreign-host'
}

/**
 * Acquire (or keep) this process's write ownership of one session directory.
 *
 * Idempotent per lock path within the acquiring module's process: a lock this
 * process already holds (matching pid) returns the current record. A live
 * foreign owner on this host refuses; an unreadable lock is treated as absent
 * and replaced (its bytes cannot name an owner to honor); a dead same-host
 * owner is superseded.
 * @param sessionDirectory - the session's own directory (created by the
 * caller before the first durable write).
 * @param onStale - observer invoked with the superseded record before a
 * stale takeover replaces it.
 * @returns the held ownership, or a refusal naming the blocking owner.
 */
export async function acquireSessionOwnership(
  sessionDirectory: string,
  onStale?: (record: SessionOwnershipRecord) => void,
): Promise<SessionOwnership | OwnershipRefusal> {
  const path = join(sessionDirectory, '.lock')
  const record: SessionOwnershipRecord = {
    pid: process.pid,
    hostname: hostname(),
    startedAt: Date.now(),
  }

  for (;;) {
    try {
      const handle = await open(path, 'wx')
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      return { path, record }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error
    }

    const held = await readOwnership(path)
    if (held === undefined) {
      // Unreadable or concurrently removed lock: a torn payload names no owner
      // to honor, so remove it and retry the create. The loop converges on the
      // create or on a readable competing record.
      await rm(path, { force: true })
      continue
    }
    if (held.pid === process.pid) return { path, record: held }
    if (held.hostname !== record.hostname) {
      return { owner: held, reason: 'foreign-host' }
    }
    if (isProcessAlive(held.pid)) {
      return { owner: held, reason: 'live-owner' }
    }
    onStale?.(held)
    await rm(path, { force: true })
  }
}

/**
 * Release a held ownership lock.
 * @param ownership - a claim previously returned by {@link acquireSessionOwnership}.
 */
export async function releaseSessionOwnership(ownership: SessionOwnership): Promise<void> {
  try {
    await rm(ownership.path, { force: true })
  } catch (error: unknown) {
    // Only an absent lock is a no-op; every other failure must surface.
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
  }
}

/** Format an ownership refusal as the fail-loud user-facing message. */
export function ownershipRefusalMessage(id: string, refusal: OwnershipRefusal): string {
  const detail = refusal.reason === 'foreign-host'
    ? `held by pid ${refusal.owner.pid} on host "${refusal.owner.hostname}"; cross-host liveness cannot be probed — remove ${JSON.stringify('<session-dir>/.lock')} there if that owner is gone`
    : `held by live pid ${refusal.owner.pid}`
  return `session "${id}" is owned by another writer (${detail}); stop that writer or resume after it exits`
}
