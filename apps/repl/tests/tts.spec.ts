import { describe, expect, it, vi } from 'vitest'
import { cleanSpokenText, deleteSynthFile, resolvePlayer, type Player } from '../src/tts.ts'

describe('cleanSpokenText', () => {
  it('strips ANSI escapes', () => {
    expect(cleanSpokenText('\u001B[90m🐳 \u001B[39m你好')).toBe('你好')
  })
  it('removes the whale prefix', () => {
    expect(cleanSpokenText('🐳 小鲸娘在此恭候')).toBe('小鲸娘在此恭候')
  })
  it('removes the user label', () => {
    expect(cleanSpokenText('你 今天好吗')).toBe('今天好吗')
  })
  it('collapses internal whitespace', () => {
    expect(cleanSpokenText('a   b\n  c')).toBe('a b c')
  })
  it('trims surrounding space', () => {
    expect(cleanSpokenText('  你好  ')).toBe('你好')
  })
  it('is empty-safe', () => {
    expect(cleanSpokenText('')).toBe('')
  })
})

describe('resolvePlayer', () => {
  const players: ReadonlyArray<Player> = [
    { name: 'afplay', args: f => [f] },
    { name: 'ffplay', args: f => ['-nodisp', f] },
    { name: 'paplay', args: f => [f] },
  ]

  it('returns the first player whose candidate exists on PATH', () => {
    const exists = (c: string): boolean => c.endsWith('afplay')
    expect(resolvePlayer(exists, players)?.name).toBe('afplay')
  })

  it('finds a later player when the earlier one is missing', () => {
    const exists = (c: string): boolean => c.endsWith('ffplay')
    expect(resolvePlayer(exists, players)?.name).toBe('ffplay')
  })

  it('probes bare names as a cwd-relative fallback after PATH dirs', () => {
    // PATH dirs contain nothing matching; the bare name probe hits afplay.
    const exists = (c: string): boolean => (c.includes('/') ? false : c === 'afplay')
    expect(resolvePlayer(exists, players)?.name).toBe('afplay')
  })

  it('returns null when no player exists anywhere', () => {
    expect(resolvePlayer(() => false, players)).toBeNull()
  })

  it('keeps player ordering (afplay before ffplay before paplay)', () => {
    const names = players.map(p => p.name)
    expect(names).toEqual(['afplay', 'ffplay', 'paplay'])
  })
})

describe('deleteSynthFile', () => {
  it('calls the default remover with the synthesized file path', async () => {
    const file = '/tmp/dsh-tts-123456-abc123.mp3'
    const remove = vi.fn(async () => {})
    await deleteSynthFile(file, remove)
    expect(remove).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith(file)
  })

  it('resolves even when removal fails (best-effort cleanup)', async () => {
    const remove = vi.fn(async () => { throw new Error('EBUSY') })
    await expect(deleteSynthFile('/tmp/dsh-tts-000000-zzz.mp3', remove)).resolves.toBeUndefined()
    expect(remove).toHaveBeenCalledOnce()
  })
})

// Real-network smoke: not part of the unit suite (needs Edge endpoint + a player).
// Run manually with: pnpm --filter @deepseek-ai/dsh-repl exec tsx -e \
//   "import {synthesize} from './src/tts.ts'; synthesize('你好').then(p=>console.log(p))"
describe.skip('synthesize (manual)', () => {
  it('synthesizes a short phrase to an mp3 file', async () => {
    const { synthesize } = await import('../src/tts.ts')
    const file = await synthesize('广山哥，你好')
    expect(file).toMatch(/\.mp3$/)
  })
})
