import { describe, expect, it } from 'vitest'
import {
  BANG_DEFAULT_TIMEOUT_MS, formatBangResult, formatBangUsage, parseBangCommand, runShellCommand,
} from '../src/bang.ts'

describe('parseBangCommand', () => {
  it('extracts the command after the bang and trims it', () => {
    expect(parseBangCommand('!ls -la')).toEqual({ kind: 'run', command: 'ls -la' })
    expect(parseBangCommand('!  git status ')).toEqual({ kind: 'run', command: 'git status' })
  })
  it('returns usage for a bare or empty bang', () => {
    expect(parseBangCommand('!')).toEqual({ kind: 'usage' })
    expect(parseBangCommand('!   ')).toEqual({ kind: 'usage' })
  })
  it('leaves non-bang input untouched', () => {
    expect(parseBangCommand('hello')).toBeUndefined()
    expect(parseBangCommand('/help')).toBeUndefined()
    expect(parseBangCommand('')).toBeUndefined()
  })
})

describe('runShellCommand', () => {
  it('captures stdout through the shell (pipes work)', async () => {
    const r = await runShellCommand('echo hello-bang | tr a-z A-Z')
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('HELLO-BANG')
    expect(r.timedOut).toBe(false)
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })
  it('resolves with the non-zero code and stderr instead of throwing', async () => {
    const r = await runShellCommand('echo oops >&2; exit 3')
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('oops')
  })
  it('marks a timed-out run as timedOut', async () => {
    const r = await runShellCommand('sleep 5', { timeoutMs: 100 })
    expect(r.timedOut).toBe(true)
    expect(r.durationMs).toBeLessThan(5_000)
  })
  it('defaults to a two-minute kill window', () => {
    expect(BANG_DEFAULT_TIMEOUT_MS).toBe(120_000)
  })
})

describe('formatBangResult', () => {
  const base = { command: 'echo hi', stdout: 'hi', stderr: '', code: 0, signal: null, timedOut: false, durationMs: 1200 }
  it('renders header, body, and exit summary', () => {
    const out = formatBangResult(base)
    expect(out).toContain('$ echo hi')
    expect(out).toContain('hi')
    expect(out).toContain('✓ 退出码 0 · 1.2s')
  })
  it('flags non-zero exits and timeouts', () => {
    expect(formatBangResult({ ...base, code: 2 })).toContain('✗ 退出码 2')
    expect(formatBangResult({ ...base, timedOut: true, code: null, signal: 'SIGKILL' })).toContain('超时被终止')
  })
  it('keeps head and tail when output exceeds the line cap', () => {
    const stdout = Array.from({ length: 500 }, (_, i) => `line-${i}`).join('\n')
    const out = formatBangResult({ ...base, stdout }, 50)
    expect(out).toContain('line-0')
    expect(out).toContain('line-499')
    expect(out).toContain('中间省略 450 行')
    expect(out).not.toContain('line-300\n')
  })
  it('renders an empty run without a body line', () => {
    const out = formatBangResult({ ...base, stdout: '', stderr: '' })
    expect(out.split('\n')).toHaveLength(2) // header + exit summary, no body
    expect(out).toContain('$ echo hi')
    expect(out).toContain('✓')
  })
  it('mentions the bang in the usage hint', () => {
    expect(formatBangUsage()).toContain('! <shell 命令>')
  })
})
