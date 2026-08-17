/**
 * Cross-process session-ownership lock behavior: create/refuse/takeover/
 * release over real file bytes, including the live-pid probe, plus the
 * backend-level refusal when a second mount tries to append a held session.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '../src/index.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import {
  acquireSessionOwnership, ownershipRefusalMessage, releaseSessionOwnership,
} from '../src/ownership.ts'

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
  vi.restoreAllMocks()
})

async function freshDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'dsh-ownership-'))
  return dir
}

describe('session ownership lock', () => {
  it('creates the lock with this process identity and releases it', async () => {
    const root = await freshDir()
    const held = await acquireSessionOwnership(root)
    expect('owner' in held).toBe(false)
    if ('owner' in held) throw new Error('expected ownership, got refusal')
    expect(held.record.pid).toBe(process.pid)
    expect(held.record.hostname).toBe(hostname())
    expect(typeof held.record.startedAt).toBe('number')
    const text = await readFile(held.path, 'utf8')
    expect(JSON.parse(text)).toEqual(held.record)
    await releaseSessionOwnership(held)
    await expect(readFile(held.path, 'utf8')).rejects.toThrow()
  })

  it('is idempotent within one process', async () => {
    const root = await freshDir()
    const first = await acquireSessionOwnership(root)
    const second = await acquireSessionOwnership(root)
    if (!('record' in first) || !('record' in second)) throw new Error('expected ownership, got refusal')
    expect(second.record).toEqual(first.record)
    await releaseSessionOwnership(first)
  })

  it('refuses loud against a live foreign pid and names the owner', async () => {
    const root = await freshDir()
    // A real live process that is not us: the test runner's own supervisor is
    // not portable, so spawn a short-lived sleeper and keep it alive for the probe.
    const { spawn } = await import('node:child_process')
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })
    try {
      await writeFile(join(root, '.lock'), `${JSON.stringify({
        pid: sleeper.pid, hostname: hostname(), startedAt: Date.now(),
      })}\n`)
      const refusal = await acquireSessionOwnership(root)
      expect('owner' in refusal).toBe(true)
      if (!('owner' in refusal)) throw new Error('expected refusal')
      expect(refusal.owner.pid).toBe(sleeper.pid)
      expect(refusal.owner.hostname).toBe(hostname())
      expect(typeof refusal.owner.startedAt).toBe('number')
      expect(refusal.reason).toBe('live-owner')
      const message = ownershipRefusalMessage('s1', refusal)
      expect(message).toContain('s1')
      expect(message).toContain(String(sleeper.pid))
      // The refusal left the owner's lock intact.
      const lockContent = JSON.parse(await readFile(join(root, '.lock'), 'utf8')) as { pid: number }
      expect(lockContent.pid).toBe(sleeper.pid)
    } finally {
      sleeper.kill('SIGKILL')
      await new Promise<void>(resolve => sleeper.once('exit', () => { resolve() }))
    }
  })

  it('takes over a dead same-host owner after the stale notice', async () => {
    const root = await freshDir()
    const staleRecord = { pid: 999_999_999, hostname: hostname(), startedAt: 123 }
    await writeFile(join(root, '.lock'), `${JSON.stringify(staleRecord)}\n`)
    const staleSeen: number[] = []
    const held = await acquireSessionOwnership(root, (stale) => { staleSeen.push(stale.pid) })
    expect(staleSeen).toEqual([999_999_999])
    expect('owner' in held).toBe(false)
    if ('owner' in held) throw new Error('expected ownership, got refusal')
    expect(held.record.pid).toBe(process.pid)
  })

  it('refuses a foreign-host owner without probing', async () => {
    const root = await freshDir()
    const foreign = { pid: 999_999_999, hostname: 'another-host', startedAt: 123 }
    await writeFile(join(root, '.lock'), `${JSON.stringify(foreign)}\n`)
    const refusal = await acquireSessionOwnership(root, () => { throw new Error('must not probe') })
    expect(refusal).toEqual({ owner: foreign, reason: 'foreign-host' })
    const message = ownershipRefusalMessage('s2', refusal as { owner: typeof foreign; reason: 'foreign-host' })
    expect(message).toContain('another-host')
  })

  it('replaces an unreadable lock payload', async () => {
    const root = await freshDir()
    await writeFile(join(root, '.lock'), '{torn json')
    const held = await acquireSessionOwnership(root)
    expect('owner' in held).toBe(false)
    if ('owner' in held) throw new Error('expected ownership, got refusal')
    expect(held.record.pid).toBe(process.pid)
    await releaseSessionOwnership(held)
  })

  it('treats a lock with a non-numeric pid as unreadable and replaces it', async () => {
    const root = await freshDir()
    await writeFile(join(root, '.lock'), '{"pid":"not-a-pid","hostname":"h","startedAt":1}')
    const held = await acquireSessionOwnership(root)
    expect('owner' in held).toBe(false)
    if ('owner' in held) throw new Error('expected ownership, got refusal')
    await releaseSessionOwnership(held)
  })

  it('keeps the lock inside the session directory where discovery ignores it', async () => {
    const root = await freshDir()
    const held = await acquireSessionOwnership(root)
    if ('owner' in held) throw new Error('expected ownership, got refusal')
    const entries = await readdir(root)
    expect(entries).toEqual(['.lock'])
    await releaseSessionOwnership(held)
    expect(await readdir(root)).toEqual([])
  })

  it('a lock released twice is a no-op', async () => {
    const root = await freshDir()
    const held = await acquireSessionOwnership(root)
    if ('owner' in held) throw new Error('expected ownership, got refusal')
    await releaseSessionOwnership(held)
    await expect(releaseSessionOwnership(held)).resolves.toBeUndefined()
  })

  it('readOwnership swallows a lock whose bytes cannot be read', async () => {
    const root = await freshDir()
    // A dangling symlink at the lock path: open fails with ENOENT (the target
    // is absent) while rm succeeds — the unreadable-payload replace path.
    const { symlink } = await import('node:fs/promises')
    await symlink(join(root, '.lock-target-absent'), join(root, '.lock'))
    const held = await acquireSessionOwnership(root)
    expect('owner' in held).toBe(false)
    if ('owner' in held) throw new Error('expected ownership, got refusal')
    await releaseSessionOwnership(held)
  })

  it('surfaces a non-EEXIST failure from the lock create', async () => {
    const root = await freshDir()
    const { chmod } = await import('node:fs/promises')
    if (userInfo().uid === 0) return // root bypasses mode bits; EACCES unreachable
    // A read-only session directory turns the O_EXCL create into EACCES — a
    // real I/O failure that must surface, not be mistaken for contention.
    await chmod(root, 0o555)
    try {
      await expect(acquireSessionOwnership(root)).rejects.toThrow()
    } finally {
      await chmod(root, 0o755)
    }
  })

  it('release surfaces a non-ENOENT removal failure', async () => {
    const root = await freshDir()
    const held = await acquireSessionOwnership(root)
    if ('owner' in held) throw new Error('expected ownership, got refusal')
    // Replace the lock file with a non-empty directory: rm -f fails EISDIR,
    // which is a real failure the release must surface.
    const { rm, mkdir } = await import('node:fs/promises')
    await rm(held.path)
    await mkdir(held.path)
    await expect(releaseSessionOwnership(held)).rejects.toThrow()
    await rm(held.path, { recursive: true })
  })

  it('an EPERM probe result still counts as a live owner', async () => {
    const root = await freshDir()
    const otherUser = userInfo().uid !== 0
    if (!otherUser) return // root sees every process as probeable; skip no-op
    // Model EPERM by mocking kill for one acquisition: EPERM means alive.
    const killMock = vi.spyOn(process, 'kill').mockImplementation((_pid: number, _signal?: string | number) => {
      const error = new Error('EPERM') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    })
    await writeFile(join(root, '.lock'), `${JSON.stringify({
      pid: 42, hostname: hostname(), startedAt: 123,
    })}\n`)
    const refusal = await acquireSessionOwnership(root)
    expect(refusal).toEqual({
      owner: { pid: 42, hostname: hostname(), startedAt: 123 },
      reason: 'live-owner',
    })
    expect(killMock).toHaveBeenCalledWith(42, 0)
  })
})

describe('backend-level cross-mount ownership', () => {
  it('a second process cannot append a session a live process holds', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-ownership-backend-'))
    const first = new Context()
    try {
      await first.plugin(SessionStore)
      await first.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
      const m = meta('held', '/work')
      await first.sessionPersistence.create(m)
      await first.sessionPersistence.append(m.id, oneTurnLog())
      // The lock now names this test process as the live owner.

      // A real second PROCESS mounting the same root must fail loud on append.
      // Same pattern as loader-smoke's `src` mode: tsx import + tsconfig paths.
      const { spawnSync } = await import('node:child_process')
      const { fileURLToPath } = await import('node:url')
      const driver = fileURLToPath(new URL('./fixtures/second-writer.ts', import.meta.url))
      const tsx = import.meta.resolve('tsx')
      const child = spawnSync(process.execPath, ['--import', tsx, driver, dir, 'held'], {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
        },
      })
      expect(child.status).toBe(1)
      expect(child.stderr ?? '').toContain('owned by another writer')

      // The first mount keeps writing; the lock survives the refused append.
      const cont = oneTurnLog().map(event => ({ ...event, seq: event.seq + 6 }))
      await expect(first.sessionPersistence.append(m.id, cont)).resolves.toBeUndefined()
    } finally {
      await first.fiber.dispose()
    }
    // Owner disposed: the lock file is gone and only the log remains.
    const projectEntries = await readdir(join(dir, '--work--', 'held'))
    expect(projectEntries).toEqual(['session.jsonl'])
  }, 90_000)

  it('a second process appends fine after the first disposes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-ownership-handoff-'))
    const first = new Context()
    await first.plugin(SessionStore)
    await first.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
    const m = meta('handoff', '/work')
    await first.sessionPersistence.create(m)
    await first.sessionPersistence.append(m.id, oneTurnLog())
    await first.fiber.dispose()

    const { spawnSync } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    const driver = fileURLToPath(new URL('./fixtures/second-writer.ts', import.meta.url))
    const tsx = import.meta.resolve('tsx')
    const child = spawnSync(process.execPath, ['--import', tsx, driver, dir, 'handoff'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
      },
    })
    expect(child.status, `child stderr: ${child.stderr}`).toBe(0)
    // 6 first-batch + 6 second-process events = 12 contiguous stored events.
    expect((child.stdout ?? '').trim()).toBe('appended 6')

    // The second process's events are on disk, contiguous past the first batch.
    const second = new Context()
    try {
      await second.plugin(SessionStore)
      await second.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
      const loaded = await second.sessionPersistence.load(m.id)
      expect(loaded.events.length).toBe(2 * oneTurnLog().length)
    } finally {
      await second.fiber.dispose()
    }
  }, 90_000)

  it('dispose releases ownership so a later mount can resume the session', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-ownership-release-'))
    const first = new Context()
    await first.plugin(SessionStore)
    await first.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
    const m = meta('resume-me', '/work')
    await first.sessionPersistence.create(m)
    await first.sessionPersistence.append(m.id, oneTurnLog())
    await first.fiber.dispose()

    const second = new Context()
    try {
      await second.plugin(SessionStore)
      await second.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
      const loaded = await second.sessionPersistence.load(m.id)
      expect(loaded.events.length).toBe(oneTurnLog().length)
      const more = oneTurnLog().map(event => ({ ...event, seq: event.seq + 6 }))
      await expect(second.sessionPersistence.append(m.id, more)).resolves.toBeUndefined()
    } finally {
      await second.fiber.dispose()
    }
  })
})
