import { describe, expect, it } from 'vitest'
import { CLIPBOARD_IMAGE_JXA, clipboardImageTo, interpretClipboardVerdict } from '../src/clipboard-image.ts'
import type { RunResult } from '../src/run.ts'

function runnerWith(stdout: string, code = 0) {
  let capturedEnv: NodeJS.ProcessEnv | undefined
  const runner = async (_bin: string, _args: readonly string[], options?: { env?: NodeJS.ProcessEnv }): Promise<RunResult> => {
    capturedEnv = options?.env
    return { code, stdout, stderr: '' }
  }
  return { runner, capturedEnv: () => capturedEnv }
}

describe('interpretClipboardVerdict', () => {
  it('maps each JXA verdict to a user-facing result', () => {
    expect(interpretClipboardVerdict('OK\n', '/tmp/a.png')).toEqual({ ok: true, path: '/tmp/a.png' })
    expect(interpretClipboardVerdict('NO_IMAGE', '/tmp/a.png').error).toContain('剪贴板里没有图片')
    expect(interpretClipboardVerdict('WRITE_FAILED', '/tmp/a.png').error).toContain('/tmp/a.png')
    expect(interpretClipboardVerdict('NO_TARGET', '/tmp/a.png').error).toContain('CLIP_IMAGE_TARGET')
    expect(interpretClipboardVerdict('', '/tmp/a.png').error).toContain('异常')
  })
})

describe('clipboardImageTo', () => {
  it('passes the target path through the environment and reports ok', async () => {
    const { runner, capturedEnv } = runnerWith('OK\n')
    const result = await clipboardImageTo('/tmp/clip-1.png', runner)
    expect(result).toEqual({ ok: true, path: '/tmp/clip-1.png' })
    expect(capturedEnv()?.CLIP_IMAGE_TARGET).toBe('/tmp/clip-1.png')
  })
  it('surfaces the verdict as a failure reason', async () => {
    const { runner } = runnerWith('NO_IMAGE')
    const result = await clipboardImageTo('/tmp/clip-2.png', runner)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('剪贴板里没有图片')
  })
  it('never rejects on spawn failure', async () => {
    const runner = async (): Promise<RunResult> => { throw new Error('spawn gone') }
    const result = await clipboardImageTo('/tmp/clip-3.png', runner)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('spawn gone')
  })
})

describe('CLIPBOARD_IMAGE_JXA', () => {
  it('reads the target from the environment and prints a verdict', () => {
    expect(CLIPBOARD_IMAGE_JXA).toContain("env.objectForKey('CLIP_IMAGE_TARGET')")
    expect(CLIPBOARD_IMAGE_JXA).toContain('NSPasteboardTypePNG')
    expect(CLIPBOARD_IMAGE_JXA).toContain('writeToFileAtomically')
  })
})
