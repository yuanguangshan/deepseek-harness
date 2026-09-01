import { describe, expect, it } from 'vitest'
import { DEFAULT_NOTIFY_MIN_MS, escapeAppleScriptString, sendSystemNotification, shouldNotifyTurnComplete } from '../src/notify.ts'
import type { RunResult } from '../src/run.ts'

const okRun = async (): Promise<RunResult> => ({ code: 0, stdout: '', stderr: '' })

describe('shouldNotifyTurnComplete', () => {
  it('gates on duration and the darwin platform', () => {
    expect(shouldNotifyTurnComplete(DEFAULT_NOTIFY_MIN_MS - 1, { platform: 'darwin' })).toEqual({ notify: false, reason: 'too-short' })
    expect(shouldNotifyTurnComplete(DEFAULT_NOTIFY_MIN_MS + 1, { platform: 'darwin' })).toEqual({ notify: true, reason: 'ok' })
    expect(shouldNotifyTurnComplete(DEFAULT_NOTIFY_MIN_MS + 1, { platform: 'linux' }).notify).toBe(false)
  })
  it('respects the explicit enabled flag over the environment default', () => {
    expect(shouldNotifyTurnComplete(DEFAULT_NOTIFY_MIN_MS + 1, { enabled: false, platform: 'darwin' })).toEqual({ notify: false, reason: 'disabled' })
  })
})

describe('escapeAppleScriptString', () => {
  it('escapes backslashes and double quotes', () => {
    expect(escapeAppleScriptString('a"b\\c')).toBe('a\\"b\\\\c')
  })
})

describe('sendSystemNotification', () => {
  it('resolves false off macOS without spawning', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      await expect(sendSystemNotification('t', 'b', okRun)).resolves.toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', { value: original })
    }
  })
  it('returns true when osascript exits zero and quotes the payload', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    let script = ''
    const runner = async (bin: string, args: readonly string[]): Promise<RunResult> => {
      expect(bin).toBe('osascript')
      script = args[args.length - 1] ?? ''
      return { code: 0, stdout: '', stderr: '' }
    }
    try {
      await expect(sendSystemNotification('标题', '说"你好"', runner)).resolves.toBe(true)
    } finally {
      Object.defineProperty(process, 'platform', { value: original })
    }
    expect(script).toContain('display notification "说\\"你好\\"" with title "标题"')
  })
})
