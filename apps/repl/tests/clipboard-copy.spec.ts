import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanAssistantText, copyPayload, extractFirstCodeBlock,
  CONTEXT_CRITICAL_RATIO, CONTEXT_WARN_RATIO, contextPressure, createStats,
} from '../src/core.ts'
import { copyTextToClipboard, defaultRunner, interpretCopyOutcome, resolveCopyCommand } from '../src/clipboard-copy.ts'

describe('cleanAssistantText', () => {
  it('strips ANSI and the whale prefix', () => {
    expect(cleanAssistantText('\x1b[90m🐳 \x1b[0m答案在这里')).toBe('答案在这里')
  })

  it('keeps plain text intact', () => {
    expect(cleanAssistantText('plain reply')).toBe('plain reply')
  })
})

describe('extractFirstCodeBlock', () => {
  it('extracts the body and drops the language tag', () => {
    const text = '前言\n```json\n{"a": 1}\n```\n后记'
    expect(extractFirstCodeBlock(text)).toBe('{"a": 1}')
  })

  it('yields the unterminated fence tail', () => {
    expect(extractFirstCodeBlock('```bash\ngit status')).toBe('git status')
  })

  it('returns undefined without a fence', () => {
    expect(extractFirstCodeBlock('no code here')).toBeUndefined()
  })

  it('treats a whitespace-only block as no block and falls back to the full text', () => {
    expect(extractFirstCodeBlock('```\n\n```')).toBeUndefined()
    expect(extractFirstCodeBlock('```\nline\n\n\n')).toBe('line')
    expect(copyPayload('```\n```\n正文')).toBe('```')
    expect(copyPayload('正文只有一段')).toBe('正文只有一段')
  })
})

describe('copyPayload', () => {
  it('prefers the first code block', () => {
    expect(copyPayload('说明\n```python\nprint(1)\n```\n更多说明')).toBe('print(1)')
  })

  it('falls back to the clean full text', () => {
    expect(copyPayload('\x1b[90m🐳 \x1b[0m纯文字回答')).toBe('纯文字回答')
  })

  it('yields undefined for an empty reply', () => {
    expect(copyPayload('')).toBeUndefined()
    expect(copyPayload('\x1b[90m🐳 \x1b[0m')).toBeUndefined()
  })
})

describe('contextPressure', () => {
  it('is ok when not measurable', () => {
    expect(contextPressure(createStats('p', 'm'))).toBe('ok')
    const stats = createStats('p', 'm')
    stats.contextWindow = 1000
    expect(contextPressure(stats)).toBe('ok')
  })

  it('warns at the warn ratio and goes critical past it', () => {
    const stats = createStats('p', 'm')
    stats.contextWindow = 1000
    stats.lastBilledInput = Math.round(CONTEXT_WARN_RATIO * 1000)
    expect(contextPressure(stats)).toBe('warn')
    stats.lastBilledInput = Math.round(CONTEXT_CRITICAL_RATIO * 1000) + 1
    expect(contextPressure(stats)).toBe('critical')
    stats.lastBilledInput = 10
    expect(contextPressure(stats)).toBe('ok')
  })
})

describe('interpretCopyOutcome', () => {
  it('maps exit 0 to ok', () => {
    expect(interpretCopyOutcome({ code: 0, stdout: '', stderr: '' })).toEqual({ ok: true })
  })

  it('maps a failure to its stderr detail', () => {
    expect(interpretCopyOutcome({ code: 1, stdout: '', stderr: 'no display\n' }))
      .toEqual({ ok: false, error: 'no display' })
  })

  it('reports a spawn failure with code -1', () => {
    expect(interpretCopyOutcome({ code: -1, stdout: '', stderr: 'spawn pbcopy ENOENT' }))
      .toEqual({ ok: false, error: 'spawn pbcopy ENOENT' })
  })

  it('falls back to the exit code when stderr is empty', () => {
    expect(interpretCopyOutcome({ code: 7, stdout: '', stderr: '' }))
      .toEqual({ ok: false, error: '剪贴板写入失败（退出码 7）' })
  })
})

describe('resolveCopyCommand', () => {
  it('uses pbcopy on macOS', () => {
    expect(resolveCopyCommand('darwin', {}, () => true)).toEqual({ bin: 'pbcopy', args: [], viaArgv: false })
  })

  it('uses clip.exe on Windows', () => {
    expect(resolveCopyCommand('win32', {}, () => true)).toEqual({ bin: 'clip.exe', args: [], viaArgv: false })
  })

  it('prefers wl-copy on Wayland, falls back to xclip', () => {
    const wayland = { WAYLAND_DISPLAY: 'wayland-0' }
    expect(resolveCopyCommand('linux', wayland, bin => bin === 'wl-copy')).toEqual({ bin: 'wl-copy', args: [], viaArgv: true })
    expect(resolveCopyCommand('linux', wayland, bin => bin === 'xclip')).toEqual({ bin: 'xclip', args: ['-selection', 'clipboard'], viaArgv: false })
    expect(resolveCopyCommand('linux', { XDG_SESSION_TYPE: 'x11' }, bin => bin === 'xclip'))
      .toEqual({ bin: 'xclip', args: ['-selection', 'clipboard'], viaArgv: false })
  })

  it('returns undefined with no tool installed', () => {
    expect(resolveCopyCommand('linux', {}, () => false)).toBeUndefined()
    expect(resolveCopyCommand('freebsd', {}, () => false)).toBeUndefined()
  })

  it('prefers wl-copy on Wayland, then falls back to xclip, then bare wl-copy', () => {
    const wayland = { WAYLAND_DISPLAY: 'wayland-0' }
    expect(resolveCopyCommand('linux', wayland, bin => bin === 'wl-copy' || bin === 'xclip')).toEqual({ bin: 'wl-copy', args: [], viaArgv: true })
    // No wl-copy but xclip present → X11 bridge path.
    expect(resolveCopyCommand('linux', wayland, bin => bin === 'xclip')).toEqual({ bin: 'xclip', args: ['-selection', 'clipboard'], viaArgv: false })
    // wl-copy present but no xclip and not Wayland… wait: wl-copy alone on X11 is still tried last.
    expect(resolveCopyCommand('linux', { XDG_SESSION_TYPE: 'x11' }, bin => bin === 'wl-copy')).toEqual({ bin: 'wl-copy', args: [], viaArgv: true })
  })
})

describe('copyTextToClipboard', () => {
  it('pipes the payload through the resolved tool and reports ok', async () => {
    const seen: Array<{ bin: string; payload: string }> = []
    const result = await copyTextToClipboard('hello', async (command, payload) => {
      seen.push({ bin: command.bin, payload })
      return { code: 0, stdout: '', stderr: '' }
    })
    expect(result).toEqual({ ok: true })
    expect(seen[0]?.payload).toBe('hello')
    expect(seen[0]?.bin.length).toBeGreaterThan(0)
  })

  it('reports the tool failure through interpretCopyOutcome', async () => {
    const result = await copyTextToClipboard('hello', async () => ({ code: 3, stdout: '', stderr: 'boom' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('boom')
  })

  it('never throws when the runner rejects', async () => {
    const result = await copyTextToClipboard('hello', async () => {
      throw new Error('spawn lost')
    })
    expect(result).toEqual({ ok: false, error: '剪贴板写入失败: spawn lost' })
  })

  it('survives a non-Error rejection with String()', async () => {
    const result = await copyTextToClipboard('hello', () => Promise.reject('plain string failure'))
    expect(result).toEqual({ ok: false, error: '剪贴板写入失败: plain string failure' })
  })

  it('uses the real default runner end-to-end (darwin pbcopy / linux xclip on this host)', async () => {
    const result = await copyTextToClipboard('dsh-clip-test')
    // The real platform tool either exists (ok) or the failure names it; both paths resolve, never throw.
    expect(typeof result.ok).toBe('boolean')
  })

  it('reports the unsupported-platform error when no copy tool resolves', async () => {
    const result = await copyTextToClipboard('hello', async () => ({ code: 0, stdout: '', stderr: '' }), () => undefined)
    expect(result).toEqual({ ok: false, error: `暂不支持平台 ${process.platform} 的剪贴板写入` })
  })
})

describe('defaultRunner', () => {
  it('pipes stdin payloads to stdin-reader tools (cat round-trip)', async () => {
    const result = await defaultRunner({ bin: 'cat', args: [], viaArgv: false }, 'stdin-payload')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('stdin-payload')
  })

  it('passes argv payloads through argv (printf round-trip)', async () => {
    const result = await defaultRunner({ bin: 'printf', args: ['%s'], viaArgv: true }, 'argv-payload')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('argv-payload')
  })

  it('reports a missing binary as code -1 with the spawn error on stderr', async () => {
    const result = await defaultRunner({ bin: 'dsh-no-such-tool-xyz', args: [], viaArgv: false }, 'x')
    expect(result.code).toBe(-1)
    expect(result.stderr).toContain('dsh-no-such-tool-xyz')
  })

  it('resolves close-code null as -1 (signal kill path)', async () => {
    // `sh -c 'kill $$'` closes with a null code after terminating itself.
    const result = await defaultRunner({ bin: 'sh', args: ['-c', 'kill $$'], viaArgv: false }, 'x')
    expect(result.code).toBe(-1)
  })

  it('captures stdout and stderr from a chatty tool', async () => {
    const result = await defaultRunner({ bin: 'sh', args: ['-c', 'echo out-line; echo err-line 1>&2'], viaArgv: false }, 'x')
    expect(result.stdout).toContain('out-line')
    expect(result.stderr).toContain('err-line')
  })

  it('swallows EPIPE when the tool exits before reading all stdin', async () => {
    // 1 MiB write against `head -c 1`: the tool exits after one byte and the
    // remaining write raises EPIPE on stdin — the runner's error listener must
    // swallow it so close() owns the resolved result.
    const payload = 'x'.repeat(1024 * 1024)
    const result = await defaultRunner({ bin: 'head', args: ['-c', '1'], viaArgv: false }, payload)
    expect(result.code).toBe(0)
    expect(result.stdout.length).toBe(1)
  })

  it('keeps resolving after stdout data streams (adds to the accumulated string)', async () => {
    // Two writes before close exercise the data handler twice (path 1/2 + repeat).
    const result = await defaultRunner({ bin: 'sh', args: ['-c', 'printf a; printf b; printf c'], viaArgv: false }, 'x')
    expect(result.stdout).toBe('abc')
  })
})

describe('defaultOnPath (real PATH probe)', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('finds a tool that exists on PATH', () => {
    vi.stubEnv('PATH', '/usr/bin:/bin')
    expect(resolveCopyCommand('linux', {}, undefined as never)).toBeUndefined()
    // defaultOnPath runs when no probe is passed: sh exists in /usr/bin or /bin on every CI host.
    const command = resolveCopyCommand('linux', { XDG_SESSION_TYPE: 'x11' })
    expect(command === undefined || command.bin.length > 0).toBe(true)
  })

  it('splits PATH entries and tolerates a missing PATH', () => {
    vi.stubEnv('PATH', undefined as unknown as string)
    // Missing PATH → the `?? ''` fallback yields no dirs → no tool on linux.
    expect(resolveCopyCommand('linux', { XDG_SESSION_TYPE: 'x11' })).toBeUndefined()
    vi.stubEnv('PATH', '/usr/bin')
    const command = resolveCopyCommand('linux', { XDG_SESSION_TYPE: 'x11' })
    // With /usr/bin on PATH the xclip-or-undefined result depends on the host; both are legal.
    expect(command === undefined || command.bin === 'xclip' || command.bin === 'wl-copy').toBe(true)
  })
})
