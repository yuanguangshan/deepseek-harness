import { describe, expect, it } from 'vitest'
import { estimateContextBreakdown, formatContextBreakdown, CHARS_PER_TOKEN } from '../src/context-estimate.ts'
import type { SessionLogEvent } from '../src/history.ts'

function event(type: string, data?: unknown): SessionLogEvent {
  return { type, time: 1_700_000_000_000, data }
}

describe('estimateContextBreakdown', () => {
  it('buckets user text, system injections, assistant text, and tool payloads', () => {
    const events = [
      event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }),
      event('user/message', { source: { kind: 'injection' }, content: [{ type: 'text', text: 'sys' }] }),
      event('assistant/message', { content: [{ type: 'text', text: 'hi there' }] }),
      event('tool/call', { name: 'bash', arguments: '{"command":"ls"}' }),
    ]
    const sections = estimateContextBreakdown(events)
    const byLabel = new Map(sections.map(s => [s.label, s.tokens]))
    expect(byLabel.get('用户消息')).toBe(Math.ceil(5 / CHARS_PER_TOKEN))
    expect(byLabel.get('系统注入')).toBe(Math.ceil(3 / CHARS_PER_TOKEN))
    expect(byLabel.get('助手回复')).toBe(Math.ceil(8 / CHARS_PER_TOKEN))
    expect(byLabel.get('工具调用/结果')).toBeGreaterThan(0)
  })
  it('is tolerant of junk data shapes', () => {
    const sections = estimateContextBreakdown([
      event('user/message', 'not-an-object'),
      event('assistant/chunk', undefined),
      event('tool/result', [1, 2]),
    ])
    expect(sections.every(s => s.tokens === 0)).toBe(true)
  })
})

describe('formatContextBreakdown', () => {
  it('sorts largest first and mentions the manual compaction hint', () => {
    const out = formatContextBreakdown([
      { label: '用户消息', tokens: 100 },
      { label: '助手回复', tokens: 900 },
    ])
    expect(out.indexOf('助手回复')).toBeLessThan(out.indexOf('用户消息'))
    expect(out).toContain('/compact')
  })
  it('shows a window percentage when the context window is known', () => {
    const out = formatContextBreakdown([{ label: '用户消息', tokens: 250 }], 1000)
    expect(out).toContain('25.0%')
  })
})
