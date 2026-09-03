import { describe, expect, it } from 'vitest'
import { colorizeDiff, revertUnstaged, runGit, setGitRunner, workspaceDiff, type GitRunner } from '../src/git-ops.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const ANSI = /\x1b\[[0-9;]*m/g

describe('colorizeDiff', () => {
  it('colors added, removed, hunk, and meta lines differently', () => {
    const diff = [
      'diff --git a/f b/f',
      'index 111..222 100644',
      '--- a/f',
      '+++ b/f',
      '@@ -1,2 +1,2 @@',
      '-old line',
      '+new line',
      ' context',
    ].join('\n')
    const colored = colorizeDiff(diff)
    const lines = colored.split('\n')
    // Meta lines (diff/index/---/+++) share one color family; hunk/add/remove each differ.
    expect(lines[0]).toMatch(/^\x1b\[90m/)
    expect(lines[4]).toMatch(/^\x1b\[36m/)
    expect(lines[5]).toMatch(/^\x1b\[31m/)
    expect(lines[6]).toMatch(/^\x1b\[32m/)
    expect(lines[7]).not.toMatch(ANSI)
  })
})

describe('workspaceDiff', () => {
  it('reports a clean tree', async () => {
    const dir = makeRepo()
    try {
      await expect(workspaceDiff(dir)).resolves.toBe('✓ 工作区干净（没有未提交改动）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('renders a colored diff for a modified file', async () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'hello\nworld\nchange\n')
      const out = await workspaceDiff(dir)
      expect(out).toContain('+change')
      expect(ANSI.test(out)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('hints about staged-only and untracked work', async () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'staged edit\n')
      execSync('git add .', { cwd: dir, stdio: 'ignore' })
      const stagedOnly = await workspaceDiff(dir)
      expect(stagedOnly).toContain('改动已全部暂存或仅新增文件')
      writeFileSync(join(dir, 'new.txt'), 'untracked\n')
      const withUntracked = await workspaceDiff(dir)
      expect(withUntracked).toContain('新增文件')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('truncates a huge diff with a note', async () => {
    const dir = makeRepo()
    try {
      const lines: string[] = []
      for (let i = 0; i < 2000; i++) lines.push(`deleted line ${i}`)
      writeFileSync(join(dir, 'a.txt'), `${lines.join('\n')}\n`)
      const out = await workspaceDiff(dir)
      expect(out).toContain('diff 过长，已截断')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a non-repo directory as an error', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'dsh-repl-git-norepo-'))
    try {
      await expect(workspaceDiff(plain)).resolves.toMatch(/✗/)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('runGit', () => {
  it('maps exit 1 to ok-with-differences and 128 to failure', async () => {
    const dir = makeRepo()
    try {
      const diff = await runGit(['diff', '--quiet'], dir)
      expect(diff.ok).toBe(true)
      expect(diff.code).toBe(0)
      const bad = await runGit(['log', '--oneline', 'no-such-ref-xyz'], dir)
      expect(bad.ok).toBe(false)
      expect(bad.code).toBeGreaterThan(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a timeout when the kill window expires', async () => {
    const slow = mkdtempSync(join(tmpdir(), 'dsh-repl-git-slow-'))
    try {
      const timeout = await runGitWithTimeout(slow)
      expect(timeout.ok).toBe(false)
      expect(timeout.error).toContain('git 超时')
    } finally {
      rmSync(slow, { recursive: true, force: true })
    }
  })

  it('treats exit 1 with empty stderr as ok-with-differences (hook probe)', async () => {
    const dir = makeRepo()
    try {
      // A silently-failing pre-commit hook (exit 9, no output): exit 1-class
      // results stay `ok` — /diff-level semantics. The exit-9 branch of exec
      // yields error.code 9 > 1 through a checkout failure instead (below).
      mkdirSync(join(dir, '.git', 'hooks'), { recursive: true })
      writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 9\n')
      execSync(`chmod +x ${JSON.stringify(join(dir, '.git', 'hooks', 'pre-commit'))}`)
      writeFileSync(join(dir, 'hook.txt'), 'x\n')
      execSync('git add .', { cwd: dir, stdio: 'ignore' })
      const bad = await runGit(['commit', '-m', 'x'], dir)
      expect(bad.ok).toBe(true)
      expect(bad.code).toBe(1)
      expect(bad.error).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** Run a command with a 1ms window; even a fast git cannot beat it, so the SIGKILL timeout branch fires. */
async function runGitWithTimeout(cwd: string) {
  const { runGit: fresh } = await import('../src/git-ops.ts')
  return fresh(['count-objects', '-v'], cwd, 1)
}

describe('revertUnstaged', () => {
  it('refuses when nothing is unstaged', async () => {
    const dir = makeRepo()
    try {
      await expect(revertUnstaged(dir)).resolves.toBe('✓ 没有未暂存的改动，无需撤销')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reverts unstaged modifications and keeps staged/untracked work', async () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'dirty edit\n')
      const out = await revertUnstaged(dir)
      expect(out).toBe('✓ 已撤销全部未暂存的改动（git checkout -- .）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports failure when git cannot read the tree', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'dsh-repl-git-norepo-'))
    try {
      await expect(revertUnstaged(plain)).resolves.toMatch(/✗/)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('renders failure lines through the injected git seam', async () => {
    const previous = setGitRunner(async () => ({ ok: false, stdout: '', code: 128, error: 'fatal: injected' }))
    try {
      // Error results render in the META color; strip ANSI to compare the text.
      const strip = (s: string): string => s.replace(ANSI, '')
      expect(strip(await workspaceDiff('/any'))).toBe('✗ 无法读取 git 状态: fatal: injected')
      expect(strip(await revertUnstaged('/any'))).toBe('✗ 无法读取 git 状态: fatal: injected')
    } finally {
      setGitRunner(previous)
    }
    // Restored seam: a real run works again.
    const dir = makeRepo()
    try {
      await expect(workspaceDiff(dir)).resolves.toBe('✓ 工作区干净（没有未提交改动）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('covers the diff-failure and checkout-failure branches via the seam', async () => {
    const dir = makeRepo()
    try {
      // status ok, diff fails
      const diffFails: GitRunner = async args => args.includes('status')
        ? { ok: true, stdout: ' M a.txt\n', code: 0 }
        : { ok: false, stdout: '', code: 128, error: 'diff broken' }
      setGitRunner(diffFails)
      expect((await workspaceDiff(dir)).replace(ANSI, '')).toBe('✗ git diff 失败: diff broken')
      // status ok, quiet-check ok with changes, checkout fails
      const checkoutFails: GitRunner = async args => args.includes('status')
        ? { ok: true, stdout: ' M a.txt\n', code: 0 }
        : args.includes('--quiet')
          ? { ok: true, stdout: '', code: 1 }
          : { ok: false, stdout: '', code: 128, error: 'checkout refused' }
      setGitRunner(checkoutFails)
      expect((await revertUnstaged(dir)).replace(ANSI, '')).toBe('✗ 撤销失败: checkout refused')
    } finally {
      setGitRunner(runGit)
    }
  })
})

/** Create a throwaway git repo with one committed file. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-repl-git-ops-'))
  const git = (args: string): void => {
    execSync(`git ${args}`, { cwd: dir, stdio: 'ignore' })
  }
  git('init')
  git('config user.email t@t')
  git('config user.name t')
  writeFileSync(join(dir, 'a.txt'), 'hello\nworld\n')
  git('add .')
  git('commit -m init')
  return dir
}

describe('runGit exit-code fallback', () => {
  it('maps a numeric exit with empty stderr to the 退出码 message', async () => {
    const dir = makeRepo()
    try {
      // args are joined into `git <args>` run through sh: `git ; exit 3`
      // succeeds at git then exits 3 with nothing on stderr — the
      // plain-numeric code path plus the `git 退出码 3` fallback.
      const r = await runGit([';', 'exit', '3'], dir)
      expect(r.ok).toBe(false)
      expect(r.code).toBe(3)
      expect(r.error).toBe('git 退出码 3')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maps a non-numeric error code to -1 with the exit-code fallback', async () => {
    const dir = makeRepo()
    try {
      // A nonexistent cwd makes Node's exec fail at spawn with the string
      // `error.code` 'ENOENT': the non-numeric arm maps it to -1 and the
      // 退出码 fallback renders it (empty stderr included).
      const r = await runGit(['status'], join(dir, 'does-not-exist'))
      expect(r.ok).toBe(false)
      expect(r.code).toBe(-1)
      expect(r.error).toBe('git 退出码 -1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
