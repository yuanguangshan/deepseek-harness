import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { StatusBar } from '../src/status-bar.ts'

describe('StatusBar', () => {
  it('renders head + metrics window + mid + right in one padded row', () => {
    const bar = new StatusBar()
    bar.setText(['5 轮 · 12 步', 'LLM 3s', 'tools 1s'], 'deepseek-v4-flash', '额度 3%', '作答中 …')
    const rows = bar.render(60)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.startsWith('作答中 … 5 轮 · 12 步')).toBe(true)
    expect(row.endsWith('  |  额度 3%  deepseek-v4-flash')).toBe(true)
  })

  it('renders without head or mid segments', () => {
    const bar = new StatusBar()
    bar.setText(['1 轮 · 1 步'], 'model')
    const win = '1 轮 · 1 步'
    // CJK glyphs occupy two terminal columns, so pad by visible width, not length.
    const [row] = bar.render(40)
    expect(row).toBe(win + ' '.repeat(40 - visibleWidth(win) - 'model'.length) + 'model')
  })

  it('regionWidth mirrors the render layout and floors at 6', () => {
    const bar = new StatusBar()
    bar.setText([], 'abc', '额度 3%', '作答中 …')
    const width = 40
    const expected = Math.max(6, width - visibleWidth('作答中 … ') - visibleWidth('  |  额度 3%  ') - 'abc'.length - 2)
    expect(bar.regionWidth(width)).toBe(expected)
    // A comically narrow terminal still leaves a usable window.
    expect(bar.regionWidth(4)).toBe(6)
  })

  it('renders an empty metrics window as head + padding + right', () => {
    const bar = new StatusBar()
    bar.setText([], 'model')
    const [row] = bar.render(30)
    expect(row!.endsWith('model')).toBe(true)
    expect(row!.startsWith(' '.repeat(30 - 'model'.length))).toBe(true)
    // An empty bar also has nothing to rotate.
    bar.stepRotate(30)
    expect(bar.start).toBe(0)
    expect(bar.dir).toBe(1)
    bar.invalidate()
  })

  it('pads with at least one space even when the content overflows', () => {
    const bar = new StatusBar()
    bar.setText(['f'.repeat(80)], 'm'.repeat(40))
    const [row] = bar.render(30)
    // The window truncates to the region, but head/pad/right stay well-formed.
    expect(row?.includes(' ')).toBe(true)
    expect(row?.endsWith('m'.repeat(40))).toBe(true)
  })

  it('steps the sliding window forward and bounces back at the right edge', () => {
    const bar = new StatusBar()
    bar.setText(['aaaa', 'bbbb', 'cccc', 'dddd'], 'xx')
    // Region comfortably fits two but not all four fields.
    const width = 30
    expect(bar.regionWidth(width)).toBeLessThan(bar.fields.join('  |  ').length)
    const seen: number[] = [bar.start]
    for (let i = 0; i < 6; i++) {
      bar.stepRotate(width)
      seen.push(bar.start)
    }
    // The window moves one field at a time and never walks past the last field.
    expect(seen.every(s => s >= 0 && s < 4)).toBe(true)
    expect(new Set(seen).size).toBeGreaterThan(1)
  })

  it('keeps a single-field bar stationary', () => {
    const bar = new StatusBar()
    bar.setText(['only'], 'xx')
    bar.stepRotate(5)
    expect(bar.start).toBe(0)
  })
})
