import { describe, expect, it } from 'vitest'
import { renderWhaleHalfBlock, stepWhaleSwim, WHALE_ROWS, type WhaleSwim } from '../src/whale-banner.ts'

const swim = (overrides: Partial<WhaleSwim> = {}): WhaleSwim => ({
  pos: 0,
  dir: 1,
  bounces: 0,
  round: 0,
  msg: 'abc',
  liveThinking: null,
  ...overrides,
})

describe('renderWhaleHalfBlock', () => {
  it('packs the 25 sprite rows into 13 terminal rows of square pixels', () => {
    const rows = renderWhaleHalfBlock()
    expect(rows).toHaveLength(13)
    for (const row of rows) {
      expect(row).toMatch(/\x1b\[0m$/) // every row closes its style
      expect(row).not.toMatch(/\x1b\[0m\x1b\[0m$/) // no doubled resets
    }
    expect(rows[0]).toBe('\x1b[0m') // the sprite's blank top rows render a bare reset
  })

  it('renders the white mouth pixels as ▀ cells', () => {
    const rows = renderWhaleHalfBlock()
    const mouth = rows.find(row => row.includes('\x1b[38;2;255;255;255m'))
    expect(mouth).toBeDefined()
    expect(mouth).toContain('▀')
  })

  it('drops the transparent right tail so rows hug the left edge', () => {
    const rows = renderWhaleHalfBlock()
    for (const row of rows) {
      expect(row.endsWith(' ')).toBe(false)
    }
  })
})

describe('stepWhaleSwim', () => {
  it('advances one step along the current direction', () => {
    expect(stepWhaleSwim(swim({ pos: 4, dir: 1 }), 80, () => 'x').pos).toBe(5)
    expect(stepWhaleSwim(swim({ pos: 4, dir: -1 }), 80, () => 'x').pos).toBe(3)
  })

  it('bounces at the right edge and counts the hit', () => {
    // "abc" is 3 wide → maxPos = 80 - 3 - 3 = 74.
    const next = stepWhaleSwim(swim({ pos: 74, dir: 1, bounces: 0 }), 80, () => 'next')
    expect(next.pos).toBe(74)
    expect(next.dir).toBe(-1)
    expect(next.bounces).toBe(1)
    expect(next.round).toBe(0) // one edge hit is only half a lap
  })

  it('advances to the next quip after two edge hits (one full lap)', () => {
    let quipCalls = 0
    const next = stepWhaleSwim(swim({ pos: 1, dir: -1, bounces: 1, round: 2 }), 80, () => {
      quipCalls += 1
      return 'new quip'
    })
    expect(next.bounces).toBe(0)
    expect(next.round).toBe(3)
    expect(next.msg).toBe('new quip')
    expect(quipCalls).toBe(1)
  })

  it('repeats the live thought instead of advancing the quip, keeping the lap count', () => {
    const next = stepWhaleSwim(swim({ pos: 1, dir: -1, bounces: 1, round: 2, liveThinking: '思考中' }), 80, () => {
      throw new Error('must not pull a canned quip while a live thought is showing')
    })
    expect(next.msg).toBe('💭 思考中')
    expect(next.bounces).toBe(2) // accumulated, not reset: the next quiet tick flips the quip
    expect(next.round).toBe(2)
  })

  it('laps in place on a degenerately narrow terminal', () => {
    // width 5, msg 3 wide → maxPos = max(0, 5 - 3 - 3) = 0: one tick satisfies
    // both edges, so the whale stays put and the lap completes immediately.
    const next = stepWhaleSwim(swim({ pos: 0, dir: 1, round: 0 }), 5, () => 'q')
    expect(next.pos).toBe(0)
    expect(next.round).toBe(1)
    expect(next.bounces).toBe(0) // the lap's two hits are consumed by the quip flip
  })

  it('carries the live-thinking flag through unchanged', () => {
    expect(stepWhaleSwim(swim({ liveThinking: null }), 80, () => 'q').liveThinking).toBeNull()
    expect(stepWhaleSwim(swim({ liveThinking: 't' }), 80, () => 'q').liveThinking).toBe('t')
  })
})

describe('WHALE_ROWS sprite', () => {
  it('is 25 rows of 40 palette characters', () => {
    expect(WHALE_ROWS).toHaveLength(25)
    for (const row of WHALE_ROWS) {
      expect(row).toHaveLength(40)
      expect(row).toMatch(/^[DBLW.]+$/)
    }
  })
})
