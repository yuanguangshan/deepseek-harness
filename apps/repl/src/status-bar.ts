/**
 * Single-line REPL status bar: left metrics + middle API-usage/quota + right model tag.
 *
 * The left metrics horizontally scroll when too wide, while a live "作答中 …"
 * header (when a turn is running) stays pinned at the left edge.
 */
import { visibleWidth } from '@earendil-works/pi-tui'
import { stepSlideWindow, type SlideDirection } from './core.ts'

/** Fill a fixed-width window with whole fields starting at `start`, no repeats. */
function windowOf(fields: readonly string[], start: number, sep: string, regionW: number): string {
  if (fields.length === 0) return ''
  const clamped = Math.max(0, Math.min(start, Math.max(0, fields.length - 1)))
  let out = ''
  let i = clamped
  for (; i < fields.length; i++) {
    const field = fields[i]
    // v8 ignore next -- i < fields.length guarantees a value; the guard is a noUncheckedIndexedAccess artifact
    if (field === undefined) break
    const candidate = out === '' ? field : `${out}${sep}${field}`
    if (out !== '' && visibleWidth(candidate) > regionW) break
    out = candidate
  }
  return out
}

export class StatusBar {
  SEP = '  |  '
  fields: string[] = []
  mid = ''
  right = ''
  head = ''
  /** Index of the first field shown in the fixed middle window (0 = leading). */
  start = 0
  /** Auto-slide direction: 1 = toward later fields, -1 = back toward the leading fields. */
  dir: SlideDirection = 1
  /** Whether auto-rotation of the middle window is active. */
  auto = true
  invalidate(): void {}
  setText(fields: string[], right: string, mid = '', head = ''): void {
    this.fields = fields
    this.right = right
    this.mid = mid
    this.head = head
  }
  /** Width available for the sliding metrics window (mirrors render). */
  regionWidth(width: number): number {
    const rw = visibleWidth(this.right)
    const mid = this.mid !== '' ? `  |  ${this.mid}  ` : ''
    const mw = visibleWidth(mid)
    const head = this.head !== '' ? `${this.head} ` : ''
    const headW = visibleWidth(head)
    // Fixed-size middle window: left status (headW) and right model (rw) stay
    // pinned; the metrics slide through the space between them, one field at a
    // time. The window never repeats a field within itself.
    return Math.max(6, width - headW - mw - rw - 2)
  }
  /** Advance the auto-slide one tick. Bounces at both edges so the window never
   *  slides past the last field and leaves the trailing space half-empty — once
   *  the right-most field is visible it moves back toward the leading fields. */
  stepRotate(width: number): void {
    const reachLast = (s: number): boolean => {
      // stepSlideWindow only consults reachLast with more than one field.
      return visibleWidth(this.fields.slice(s).join(this.SEP)) <= this.regionWidth(width)
    }
    const next = stepSlideWindow(this.start, this.dir, this.fields.length, reachLast)
    this.start = next.start
    this.dir = next.dir
  }
  render(width: number): string[] {
    const rw = visibleWidth(this.right)
    const mid = this.mid !== '' ? `  |  ${this.mid}  ` : ''
    const mw = visibleWidth(mid)
    const head = this.head !== '' ? `${this.head} ` : ''
    const headW = visibleWidth(head)
    const regionW = this.regionWidth(width)
    const win = windowOf(this.fields, this.start, this.SEP, regionW)
    const pad = ' '.repeat(Math.max(1, width - headW - visibleWidth(win) - mw - rw))
    return [head + win + pad + mid + this.right]
  }
}
