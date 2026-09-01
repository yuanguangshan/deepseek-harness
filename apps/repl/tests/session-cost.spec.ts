import { describe, expect, it } from 'vitest'
import { formatSessionCost } from '../src/session-cost.ts'
import { DEEPSEEK_CNY_PER_MTOK } from '../src/core.ts'

describe('formatSessionCost', () => {
  it('prices the three token buckets at the shared list prices', () => {
    const out = formatSessionCost({ billedInput: 1_000_000, outputTokens: 1_000_000, cacheRead: 1_000_000, turns: 4 })
    const expected = DEEPSEEK_CNY_PER_MTOK.inputCacheMiss + DEEPSEEK_CNY_PER_MTOK.output + DEEPSEEK_CNY_PER_MTOK.inputCacheHit
    expect(out).toContain('4 轮')
    expect(out).toContain(`¥${expected.toFixed(4)}`)
    expect(out).toContain('计费输入 1.0M')
    expect(out).toContain('缓存命中 1.0M')
    expect(out).toContain('输出 1.0M')
  })
  it('formats sub-kilo token counts as plain integers', () => {
    const out = formatSessionCost({ billedInput: 512, outputTokens: 64, cacheRead: 0, turns: 1 })
    expect(out).toContain('计费输入 512')
    expect(out).toContain('输出 64')
  })
})
