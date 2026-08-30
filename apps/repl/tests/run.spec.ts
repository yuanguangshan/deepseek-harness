import { describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommand } from '../src/run.ts'

describe('runCommand', () => {
  it('collects stdout, stderr, and the exit code of a successful run', async () => {
    const result = await runCommand(process.execPath, ['-e', "console.log('out'); console.error('err')"])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('out\n')
    expect(result.stderr).toContain('err')
  })

  it('forwards complete stdout lines while running, including an unterminated tail', async () => {
    const lines: string[] = []
    const result = await runCommand(
      process.execPath,
      ['-e', "console.log('first'); process.stdout.write('second\\npartial-tail')"],
      { onStdoutLine: (line) => { lines.push(line) } },
    )
    // The full stdout still arrives even though the callback stripped the lines.
    expect(result.stdout).toBe('first\nsecond\npartial-tail')
    expect(lines).toEqual(['first', 'second', 'partial-tail'])
  })

  it('does not forward blank lines to the callback', async () => {
    const lines: string[] = []
    await runCommand(process.execPath, ['-e', "console.log('a'); console.log(); console.log('b')"], {
      onStdoutLine: (line) => { lines.push(line) },
    })
    expect(lines).toEqual(['a', 'b'])
  })

  it('resolves a non-zero exit code without rejecting', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.exit(3)'])
    expect(result.code).toBe(3)
  })

  it('resolves code -1 with the error message when the binary cannot spawn', async () => {
    const result = await runCommand('dsh-repl-definitely-not-a-binary', [])
    expect(result.code).toBe(-1)
    expect(result.stderr).toContain('dsh-repl-definitely-not-a-binary')
  })

  it('resolves code -1 through a configured timeout window when the binary cannot spawn', async () => {
    const result = await runCommand('dsh-repl-definitely-not-a-binary', [], { timeoutMs: 10_000 })
    // The spawn error wins immediately; the timeout timer is cleared, not awaited.
    expect(result.code).toBe(-1)
    expect(result.stderr).toContain('dsh-repl-definitely-not-a-binary')
  })

  it('kills the child when the timeout elapses', async () => {
    const result = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 150 })
    // SIGKILL leaves no exit code; the run still resolves instead of hanging.
    expect(result.code).not.toBe(0)
  })

  it('runs the child in the requested working directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-repl-run-'))
    try {
      // macOS resolves /var/… to /private/var/…, so compare the real path.
      const result = await runCommand(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: dir })
      expect(result.stdout).toBe(realpathSync(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
