import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runCommand } from '../src/run.ts'

// The worker is a plain CJS script (it runs under bare `node` in production),
// so tests load it through require and exercise its exported pure helpers.
const require = createRequire(import.meta.url)
const worker = require('../tts-worker.cjs') as {
  buildSsml: (voice: string, text: string, lang: string, rate: string, pitch: string, volume: string) => string
  generateSecMsGecToken: (now?: number) => string
  xmlEscape: (s: string) => string
}

describe('generateSecMsGecToken', () => {
  it('is a deterministic 64-char uppercase hex digest for a pinned clock', () => {
    const token = worker.generateSecMsGecToken(1_700_000_000_000)
    expect(token).toMatch(/^[0-9A-F]{64}$/)
    expect(worker.generateSecMsGecToken(1_700_000_000_000)).toBe(token)
  })

  it('is stable within one 5-minute tick and changes across ticks', () => {
    // The window aligns on absolute 5-minute ticks since the Windows epoch
    // (11 644 473 600 s itself is tick-aligned), so pick a base second that sits
    // exactly on a boundary: 1_700_000_100 % 300 === 0.
    const base = 1_700_000_100_000
    const tick = worker.generateSecMsGecToken(base)
    // 299 s later: the same 5-minute window → the same token (server-side cache window).
    expect(worker.generateSecMsGecToken(base + 299_000)).toBe(tick)
    // 301 s later: the next window → a different token.
    expect(worker.generateSecMsGecToken(base + 301_000)).not.toBe(tick)
  })
})

describe('xmlEscape', () => {
  it('escapes the five XML entities', () => {
    expect(worker.xmlEscape('a&b<c>d"e\'f')).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f')
  })
})

describe('buildSsml', () => {
  it('embeds voice, language, prosody, and the escaped text', () => {
    const ssml = worker.buildSsml('zh-CN-XiaoxuanNeural', '你好 & 再见', 'zh-CN', '+10%', '-5%', '+50%')
    expect(ssml).toContain('xml:lang="zh-CN"')
    expect(ssml).toContain('<voice name="zh-CN-XiaoxuanNeural">')
    expect(ssml).toContain('<prosody rate="+10%" pitch="-5%" volume="+50%">')
    expect(ssml).toContain('你好 &amp; 再见')
    expect(ssml.startsWith('<speak version="1.0"')).toBe(true)
    expect(ssml.endsWith('</prosody></voice></speak>')).toBe(true)
  })

  it('escapes a hostile voice name', () => {
    const ssml = worker.buildSsml('x"y', 'hi', 'en-US', 'default', 'default', 'default')
    expect(ssml).toContain('<voice name="x&quot;y">')
  })
})

describe('worker script entry', () => {
  it('fails loud on empty stdin without touching the network', async () => {
    const workerPath = fileURLToPath(new URL('../tts-worker.cjs', import.meta.url))
    const result = await runCommand(process.execPath, [workerPath], { timeoutMs: 10_000 })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('ERR empty text')
  })
})
