import { describe, expect, it } from 'vitest'
import { clampSnippet, findSnippets, fuzzyScore, searchableLines, NO_MATCH } from '../src/fuzzy-search.ts'
import type { SessionLogEvent } from '../src/history.ts'

function event(type: string, data?: unknown): SessionLogEvent {
  return { type, time: 1, data }
}

describe('fuzzyScore', () => {
  it('matches case-insensitive subsequences and misses otherwise', () => {
    expect(fuzzyScore('abc', 'xxa xb xc')).toBeGreaterThan(0)
    expect(fuzzyScore('xyz', 'abc')).toBe(NO_MATCH)
    expect(fuzzyScore('', 'abc')).toBe(NO_MATCH)
  })
  it('rewards contiguous runs and word starts over scattered hits', () => {
    const contiguous = fuzzyScore('con', 'config')
    const scattered = fuzzyScore('con', 'c x o n z')
    expect(contiguous).toBeGreaterThan(scattered)
    const wordStart = fuzzyScore('deploy', 'run deploy')
    const midWord = fuzzyScore('deploy', 'nodeploy')
    expect(wordStart).toBeGreaterThan(midWord)
  })
})

describe('searchableLines', () => {
  it('collects user text and assistant text blocks only', () => {
    const lines = searchableLines([
      event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '用户的问题' }] }),
      event('assistant/message', { content: [{ type: 'text', text: '回答一' }, { type: 'text', text: '回答二' }] }),
      event('tool/call', { name: 'bash', arguments: '{}' }),
      event('user/message', { content: [{ type: 'image' }] }),
    ])
    expect(lines).toEqual(['用户的问题', '回答一', '回答二'])
  })
})

describe('findSnippets', () => {
  const events = [
    event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我写正则' }] }),
    event('assistant/message', { content: [{ type: 'text', text: '用正则表达式匹配' }] }),
  ]
  it('returns best-scoring lines first', () => {
    const hits = findSnippets(events, '正则')
    expect(hits.length).toBe(2)
    expect(hits[0]?.snippet).toContain('正则')
  })
  it('caps hits and tolerates junk shapes', () => {
    expect(findSnippets([], 'x')).toEqual([])
    expect(findSnippets([event('user/message', 'junk')], 'x')).toEqual([])
  })
})

describe('clampSnippet', () => {
  it('keeps short snippets whole and ellipsizes long ones', () => {
    expect(clampSnippet('短', '短')).toBe('短')
    const long = 'x'.repeat(100)
    expect(clampSnippet(long, 'x')).toHaveLength(71) // 70 chars + trailing '…'
  })
})
