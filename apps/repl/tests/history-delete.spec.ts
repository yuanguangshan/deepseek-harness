import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteSessionDir, encodeSessionId, projectKey } from '../src/history.ts'

describe('deleteSessionDir', () => {
  it('deletes the session directory and reports missing afterwards', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repl-history-del-'))
    const cwd = '/tmp/demo'
    const dir = join(root, projectKey(cwd), encodeSessionId('repl-del-1'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl.zstd'), 'x')
    expect(existsSync(dir)).toBe(true)

    expect(deleteSessionDir('repl-del-1', { DSH_SESSION_ROOT: root }, cwd)).toBe('deleted')
    expect(existsSync(dir)).toBe(false)
    expect(deleteSessionDir('repl-del-1', { DSH_SESSION_ROOT: root }, cwd)).toBe('missing')
  })

  it('does not delete sibling sessions', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repl-history-del-'))
    const cwd = '/tmp/demo'
    const keep = join(root, projectKey(cwd), encodeSessionId('repl-keep'))
    mkdirSync(keep, { recursive: true })
    writeFileSync(join(keep, 'session.jsonl.zstd'), 'x')

    expect(deleteSessionDir('repl-other', { DSH_SESSION_ROOT: root }, cwd)).toBe('missing')
    expect(existsSync(keep)).toBe(true)
  })

  it('reports error when the removal fails for a non-ENOENT reason', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repl-history-del-'))
    const cwd = '/tmp/demo'
    const parent = join(root, projectKey(cwd))
    // A FILE where the session directory should be: rmSync on the file itself
    // succeeds, so instead block the parent with a read-only directory.
    mkdirSync(parent, { recursive: true })
    const sessionDir = join(parent, encodeSessionId('repl-locked'))
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.jsonl.zstd'), 'x')
    // A nested child that cannot be removed: make the leaf a non-empty directory
    // whose parent entry is read-only. Simplest deterministic non-ENOENT failure:
    // point sessionRoot at a path whose ancestor component is a FILE.
    const fileAsDir = join(root, 'blocker')
    writeFileSync(fileAsDir, 'x')
    const outcome = deleteSessionDir('repl-locked', { DSH_SESSION_ROOT: join(fileAsDir, 'sub') }, cwd)
    expect(outcome).toBe('error')
  })
})
