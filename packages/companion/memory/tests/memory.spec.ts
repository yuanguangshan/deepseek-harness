import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENTRY_DELIMITER, MemoryStore, clamp, locate, memoryDir, parseEntries, parseEntryBranches,
  projectHash, projectLabel, renderMemorySnapshot, serializeEntries, stampEntry, todayStamp,
} from '../src/index.ts'

function tmpStore(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'))
  return new MemoryStore({ dir })
}

function cleanup(store: MemoryStore): void {
  rmSync(store.dir, { recursive: true, force: true })
}

describe('parseEntries / serializeEntries', () => {
  it('round-trips entries through the separator', () => {
    const entries = ['first', 'second', 'third']
    expect(parseEntries(serializeEntries(entries))).toEqual(entries)
  })
  it('skips blank segments', () => {
    expect(parseEntries(`${ENTRY_DELIMITER}\n  \n${ENTRY_DELIMITER}only`)).toEqual(['only'])
  })
  it('serializes an empty list to empty string', () => {
    expect(serializeEntries([])).toBe('')
  })
})

describe('pure helpers', () => {
  it('todayStamp and timeStamp are stable strings', () => {
    expect(todayStamp(new Date('2026-08-15T10:00:00'))).toBe('2026-08-15')
  })
  it('clamp truncates over-long text with an ellipsis', () => {
    expect(clamp('abc', 5)).toBe('abc')
    expect(clamp('abcdefg', 5)).toBe('abcde…')
  })
  it('projectHash is stable and projectLabel takes the last segment', () => {
    const a = projectHash('/work/src/app')
    expect(a).toBe(projectHash('/work/src/app'))
    expect(projectLabel('/work/src/app')).toBe('app')
  })
  it('parseEntryBranches reads a branch scope or returns null when untagged', () => {
    expect(parseEntryBranches('[branch:topic-a,main] thing')).toEqual(['main', 'topic-a'])
    expect(parseEntryBranches('[branch:main] x')).toEqual(['main'])
    expect(parseEntryBranches('no tag')).toBeNull()
    expect(parseEntryBranches('[branch:,] x')).toBeNull() // empty names → no scope
  })
  it('memoryDir honors DSH_REPL_MEMORY_DIR else falls back to ~/.dsh-repl/memory', () => {
    expect(memoryDir({ DSH_REPL_MEMORY_DIR: '/tmp/x' })).toBe('/tmp/x')
    expect(memoryDir({ DSH_REPL_MEMORY_DIR: '' })).toContain('.dsh-repl')
    expect(memoryDir({})).toContain('.dsh-repl')
  })
  it('projectLabel falls back to the raw cwd when it has no segments', () => {
    expect(projectLabel('/')).toBe('/')
  })
})

describe('stampEntry', () => {
  it('stamps long-term memory with a date prefix', () => {
    const now = new Date('2026-08-15T10:00:00')
    const { stamped } = stampEntry('memory', 'remember deploy port 8080', undefined, now)
    expect(stamped).toBe('[2026-08-15] remember deploy port 8080')
  })
  it('is idempotent for content that already carries the date', () => {
    const now = new Date('2026-08-15T10:00:00')
    const { stamped } = stampEntry('memory', '[2026-08-15] remember this', undefined, now)
    expect(stamped).toBe('[2026-08-15] remember this')
  })
  it('daily entries carry time + project label', () => {
    const now = new Date('2026-08-15T14:30:00')
    const { stamped } = stampEntry('daily', 'investigated memory plugin', '/work/proj', now)
    expect(stamped).toContain('[14:30]')
    expect(stamped).toContain('[proj]')
    expect(stamped).toContain('investigated memory plugin')
  })
  it('daily entries omit the project label without a cwd', () => {
    const now = new Date('2026-08-15T14:30:00')
    const { stamped } = stampEntry('daily', 'no project', undefined, now)
    expect(stamped).toContain('[14:30]')
    expect(stamped).toMatch(/^\[\d{2}:\d{2}\] no project$/)
  })
  it('project/key entries carry dated-time prefix', () => {
    const now = new Date('2026-08-15T14:30:00')
    const { stamped } = stampEntry('key', 'critical fact', '/work/proj', now)
    expect(stamped).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] critical fact$/)
  })
})

describe('MemoryStore', () => {
  it('stores global memory and user tracks at the root', () => {
    const s = tmpStore()
    try {
      s.add('memory', 'a cross-session fact', undefined, new Date('2026-08-15T08:00:00'))
      s.add('user', 'user prefers Chinese', undefined, new Date('2026-08-15T08:00:00'))
      expect(s.entriesOf('memory')).toEqual(['[2026-08-15] a cross-session fact'])
      expect(s.entriesOf('user')).toEqual(['[2026-08-15] user prefers Chinese'])
      // Global tracks live directly under the memory dir.
      expect(readFileSync(join(s.dir, 'MEMORY.md'), 'utf8')).toContain('a cross-session fact')
      expect(readFileSync(join(s.dir, 'USER.md'), 'utf8')).toContain('user prefers Chinese')
    } finally {
      cleanup(s)
    }
  })

  it('does not stamp a date prefix when entryDatePrefix is disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memnp-'))
    const s = new MemoryStore({ dir, entryDatePrefix: false })
    try {
      s.add('memory', 'plain fact', undefined, new Date('2026-08-15T08:00:00'))
      expect(s.entriesOf('memory')).toEqual(['plain fact'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readRaw returns empty for an unresolvable project track', () => {
    const s = tmpStore()
    try {
      expect(s.readRaw('project', undefined)).toBe('')
    } finally {
      cleanup(s)
    }
  })

  it('does not duplicate identical entries', () => {
    const s = tmpStore()
    try {
      s.add('memory', 'same fact', undefined, new Date('2026-08-15T08:00:00'))
      s.add('memory', 'same fact', undefined, new Date('2026-08-15T08:00:00'))
      expect(s.entriesOf('memory')).toHaveLength(1)
    } finally {
      cleanup(s)
    }
  })

  it('separates project and key tracks by cwd hash', () => {
    const s = tmpStore()
    try {
      s.add('project', 'built X', '/work/a', new Date('2026-08-15T09:00:00'))
      s.add('key', 'auth uses JWT', '/work/a', new Date('2026-08-15T09:00:00'))
      s.add('key', 'other proj fact', '/work/b', new Date('2026-08-15T09:00:00'))
      expect(s.entriesOf('project', '/work/a')).toHaveLength(1)
      expect(s.entriesOf('key', '/work/a')).toHaveLength(1)
      expect(s.entriesOf('key', '/work/a')[0]).toContain('JWT')
      // A different project sees its own key only.
      expect(s.entriesOf('key', '/work/b')[0]).toContain('other proj fact')
    } finally {
      cleanup(s)
    }
  })

  it('project key track is branch-scoped when keyBranchFilter is on', () => {
    // In a temp (non-git) dir gitBranch is undefined → no filter applied.
    const s = tmpStore()
    try {
      s.add('key', '[branch:main] on main fact', '/work/a', new Date('2026-08-15T09:00:00'))
      // No git repo → branch unresolved → entries pass through.
      expect(s.entriesOf('key', '/work/a')).toHaveLength(1)
    } finally {
      cleanup(s)
    }
  })

  it('filters project key entries to the live git branch inside a real worktree', () => {
    const gitDir = mkdtempSync(join(tmpdir(), 'memgit-'))
    try {
      const sh = (cmd: string): void => { execFileSync('sh', ['-c', cmd], { cwd: gitDir, stdio: 'ignore' }) }
      sh('git init -q -b main .')
      sh('git config user.email t@t.t && git config user.name t')
      sh('touch f && git add f && git commit -qm init')

      const s = new MemoryStore({ dir: mkdtempSync(join(tmpdir(), 'memst-')) })
      try {
        s.add('key', '[branch:main] on main', gitDir, new Date('2026-08-15T09:00:00'))
        s.add('key', '[branch:other,main] on other-or-main', gitDir, new Date('2026-08-15T09:00:00'))
        s.add('key', 'untagged always', gitDir, new Date('2026-08-15T09:00:00'))
        const scoped = s.entriesOf('key', gitDir)
        expect(scoped.some(e => e.includes('on main'))).toBe(true)
        // branch:other-only entries are filtered out on main.
        s.add('key', '[branch:weird] weird', gitDir, new Date('2026-08-15T09:00:00'))
        expect(s.entriesOf('key', gitDir).some(e => e.includes('weird'))).toBe(false)
        // Detached HEAD → gitBranch returns empty → no filter (conservative).
        sh('git checkout -q --detach')
        expect(s.entriesOf('key', gitDir).some(e => e.includes('weird'))).toBe(true)
      } finally {
        rmSync(s.dir, { recursive: true, force: true })
      }
    } finally {
      rmSync(gitDir, { recursive: true, force: true })
    }
  })

  it('removes entries containing a needle', () => {
    const s = tmpStore()
    try {
      s.add('memory', 'keep me', undefined, new Date('2026-08-15T08:00:00'))
      s.add('memory', 'drop me', undefined, new Date('2026-08-15T08:00:00'))
      expect(s.remove('memory', 'drop')).toBe(1)
      expect(s.entriesOf('memory')).toHaveLength(1)
      expect(s.entriesOf('memory')[0]).toContain('keep me')
      // A needle that matches nothing → 0, no change.
      expect(s.remove('memory', 'absent')).toBe(0)
      expect(s.entriesOf('memory')).toHaveLength(1)
    } finally {
      cleanup(s)
    }
  })

  it('dailyDates returns empty when no daily logs exist', () => {
    const s = tmpStore()
    try {
      expect(s.dailyDates()).toEqual([])
    } finally {
      cleanup(s)
    }
  })

  it('clear removes every historical daily file, not just today\'s', () => {
    const s = tmpStore()
    try {
      s.add('daily', 'entry today', '/w', new Date('2026-08-15T09:00:00'))
      // `add` always lands in today's real-date file; seed a historical day directly.
      mkdirSync(join(s.dir, 'daily'), { recursive: true })
      writeFileSync(join(s.dir, 'daily', '2026-01-01.md'), 'older day', 'utf8')
      expect(s.dailyDates().length).toBeGreaterThanOrEqual(2)
      s.clear('daily')
      expect(s.dailyDates()).toEqual([])
      expect(s.entriesOf('daily')).toEqual([])
    } finally {
      cleanup(s)
    }
  })

  it('clear daily is a no-op without a daily directory', () => {
    const s = tmpStore()
    try {
      // No daily/ dir → the existsSync guard short-circuits.
      s.clear('daily')
      expect(s.dailyDates()).toEqual([])
    } finally {
      cleanup(s)
    }
  })

  it('clear daily skips non-markdown files', () => {
    const s = tmpStore()
    try {
      mkdirSync(join(s.dir, 'daily'), { recursive: true })
      writeFileSync(join(s.dir, 'daily', '2026-01-01.md'), 'older day', 'utf8')
      writeFileSync(join(s.dir, 'daily', 'notes.txt'), 'not a log', 'utf8')
      s.clear('daily')
      expect(s.dailyDates()).toEqual([])
      // Only *.md logs are cleared; unrelated files are left alone.
      expect(readdirSync(join(s.dir, 'daily'))).toEqual(['notes.txt'])
    } finally {
      cleanup(s)
    }
  })

  it('clear empties a single-file track', () => {
    const s = tmpStore()
    try {
      s.add('memory', 'fact', undefined, new Date('2026-08-15T09:00:00'))
      s.clear('memory')
      expect(s.entriesOf('memory')).toEqual([])
    } finally {
      cleanup(s)
    }
  })

  it('locate resolves all five tracks', () => {
    expect(locate('/mem', 'memory')).toEqual({ dir: '/mem', file: 'MEMORY.md' })
    expect(locate('/mem', 'user')).toEqual({ dir: '/mem', file: 'USER.md' })
    expect(locate('/mem', 'daily')?.file).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/)
    expect(locate('/mem', 'project', '/w')).toBeDefined()
    expect(locate('/mem', 'key', '/w')?.file).toBe('KEY.md')
    expect(locate('/mem', 'project')).toBeUndefined()
  })

  it('write is a no-op for a project track without a cwd', () => {
    const s = tmpStore()
    try {
      // No cwd → locate returns undefined → write returns without touching disk.
      s.write('project', ['ignored'], undefined)
      expect(readdirSync(s.dir)).toEqual([])
    } finally {
      cleanup(s)
    }
  })
})

describe('renderMemorySnapshot', () => {
  it('returns empty when there is nothing to show', () => {
    expect(renderMemorySnapshot({})).toBe('')
  })
  it('sections long-term memory, user profile, and project key facts', () => {
    const out = renderMemorySnapshot({
      memory: ['[2026-08-15] fact a', '[2026-08-15] fact b'],
      user: ['[2026-08-15] prefs'],
      key: ['[2026-08-15 10:00] jwt'],
      branch: 'main',
    })
    expect(out).toContain('## 长期记忆')
    expect(out).toContain('fact a')
    expect(out).toContain('## 用户档案')
    expect(out).toContain('prefs')
    expect(out).toContain('## 本项目的关键记忆')
    expect(out).toContain('当前 git 分支：main')
  })
  it('caps per-entry length', () => {
    const out = renderMemorySnapshot({ memory: ['x'.repeat(200)], maxEntry: 5 })
    expect(out).toContain('xxxxx…')
  })
  it('renders project key memory without a branch hint when branch is unknown', () => {
    const out = renderMemorySnapshot({ key: ['[2026-08-15 10:00] fact'] })
    expect(out).toContain('## 本项目的关键记忆')
    expect(out).not.toContain('git 分支')
  })
})

describe('readonly-method smoke', () => {
  it('enumerates daily log dates across writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memd-'))
    const s = new MemoryStore({ dir })
    try {
      s.add('daily', 'entry one', '/w', new Date('2026-08-15T10:00:00'))
      s.write('daily', ['[10:00] two'], '/w')
      // `daily` tracks always land in the *real* current date's file (locate uses
      // todayStamp()), so assert against today rather than the stamped entry date.
      expect(readdirSync(join(dir, 'daily'))).toEqual([`${todayStamp()}.md`])
      expect(s.dailyDates().length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
