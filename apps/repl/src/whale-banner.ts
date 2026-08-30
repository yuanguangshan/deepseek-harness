/**
 * Pixel-whale startup banner, ported from the dsh-TUI third-party plugin
 * (`@deepseek-harness-tui/dsh-tui` → `src/components/Whale.tsx` +
 * `src/components/whaleFrames.ts`, MIT).
 *
 * The sprite is a 25-row × 40-col palette art. Palette alphabet:
 *   `D` deep-navy outline    (20,38,96)     -- 轮廓
 *   `B` DeepSeek-blue body   (78,111,255)   -- 身体
 *   `L` ice-blue belly       (190,225,255)  -- 肚皮
 *   `W` white mouth          (255,255,255)  -- 嘴
 *   `.` transparent / empty
 *
 * The {@link renderWhaleHalfBlock} renderer packs each sprite row PAIR into ONE
 * terminal row, so the 40×25 sprite shows as 40 cols × 13 rows of visually
 * square, anti-aliased pixels — the "fully rendered" look from dsh-TUI. It
 * returns plain strings, no terminal dependency, as does the swim animation
 * state machine for the working-phase whale.
 */

import { visibleWidth } from '@earendil-works/pi-tui'

type Rgb = readonly [number, number, number]

/** True-color ANSI codes. */
const fg = (rgb: Rgb): string => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
const bg = (rgb: Rgb): string => `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
const RESET = '\x1b[0m'

/** Palette: palette char → RGB, or undefined for transparent. */
const PALETTE: Record<string, Rgb | undefined> = {
  D: [20, 38, 96],
  B: [78, 111, 255],
  L: [190, 225, 255],
  W: [255, 255, 255],
}

/** The classic (default) whale sprite: 25 rows of 40 palette characters. */
export const WHALE_ROWS: readonly string[] = [
  '........................................',
  '........................................',
  '........................D...............',
  '.......................DBD.......D......',
  '.......................DBBD.....DBD.....',
  '.......................DBBBD..DDBBD.....',
  '.......................DBBBBDDBBBBD.....',
  '.......DDDDDDDDD........DBBBBBBBBD......',
  '......DBBBBBBBBBDD.......DBBBBBBBD......',
  '.....DBBBBBBBBBBBBDD.....DBBBBBDD.......',
  '....DBBBBBBBBBBBBBBBDD....DBBBD.........',
  '...DDBBBBBBBBBBBBBBBBBD..DBBBBD.........',
  '...DBBBBBBBBBBBBBBBBBBBDDBBBBBD.........',
  '...DBBBDBBBBBBDBBBBBBBBBBBBBBBD.........',
  '...DBBBDBBBBBBDBBBBBBBBBBBBBBD..........',
  '...DBBBBBBBBBBBBBBBBBBBBBBBBBD..........',
  '...DBBBBWWWWWWWBBBBBBBBDBBBBD...........',
  '...DDBWWWWWWWWWWWWBBBBBBDBBBD...........',
  '....DLLWWWWWWWWWWWWDBBBBDDBD............',
  '.....DLLLWWWWWWWWWWDBBBBBDD.............',
  '......DDLLLWWWWWWLLLDBBBBBDD............',
  '........DLLLLLLLLLLLDDBBBBBBD...........',
  '.........DDDDDDDDDDD..DDDDDDD...........',
  '........................................',
  '........................................',
]

/**
 * Half-block `▀`/`▄` renderer: one terminal row per sprite row PAIR, so the
 * 40×25 sprite becomes 40 cols × 13 rows of visually square pixels.
 *
 * For each cell, the upper sprite pixel goes in the foreground and the lower
 * one in the background:
 *   up present + lo present → `▀` with fg=up, bg=lo
 *   up present           → `▀` with fg=up
 *   lo present           → `▄` with fg=lo
 *   neither              → space
 * Consecutive cells sharing one style are run-length encoded; the transparent
 * tail is dropped; the row always ends with RESET so style never leaks.
 */
export function renderWhaleHalfBlock(rows: readonly string[] = WHALE_ROWS): string[] {
  const out: string[] = []
  for (let r = 0; r < rows.length; r += 2) {
    // The loop bound keeps `rows[r]` in range; the fallback is dead.
    // v8 ignore next -- r < rows.length
    const upper = rows[r] ?? ''
    const lower = rows[r + 1] ?? ''
    let line = ''
    let current = ''
    for (let x = 0; x < upper.length; x++) {
      const upChar = upper[x]
      const loChar = lower[x]
      // x runs below upper.length, so upChar is always defined here.
      // v8 ignore next -- x < upper.length
      const up = upChar === undefined ? undefined : PALETTE[upChar]
      const lo = loChar === undefined ? undefined : PALETTE[loChar]
      let seq: string
      let ch: string
      if (up !== undefined && lo !== undefined) {
        seq = fg(up) + bg(lo)
        ch = '\u2580' // ▀
      } else if (up !== undefined) {
        seq = fg(up)
        ch = '\u2580'
      } else if (lo !== undefined) {
        seq = fg(lo)
        ch = '\u2584' // ▄
      } else {
        seq = ''
        ch = ' '
      }
      if (seq !== current) {
        line += seq === '' ? RESET : seq
        current = seq
      }
      line += ch
    }
    let row = line.replace(/[ ]+$/, '')
    if (!row.endsWith(RESET)) row += RESET
    out.push(row)
  }
  return out
}

/**
 * Mutable animation state for the working-phase whale swimming across the
 * status row: position and direction in visible columns, lap bookkeeping, and
 * the currently displayed message (a canned quip or a live thought).
 */
export interface WhaleSwim {
  /** Current left offset in visible columns. */
  pos: number
  /** Current travel direction: 1 = rightward, -1 = leftward. */
  dir: 1 | -1
  /** Edge hits since the last quip change; two bounces = one full lap. */
  bounces: number
  /** Quip index of the current lap. */
  round: number
  /** The currently displayed message (a canned quip or `💭 <live thought>`). */
  msg: string
  /** The model's latest real thinking line, or null for the canned quip pool. */
  liveThinking: string | null
}

/**
 * Advance the swim one tick, pure so the animation rule stays unit-testable:
 * one step along `dir`, bouncing at the row edges (the row is `width` visible
 * columns and the whale renders as `🐳 <msg>`, hence the 3-column headroom).
 * While a live thought is set the whale repeats it; otherwise two edge hits (a
 * full lap) pull the next canned quip. The caller owns the timer and render.
 */
export function stepWhaleSwim(swim: WhaleSwim, width: number, nextQuip: (round: number) => string): WhaleSwim {
  const maxPos = Math.max(0, width - visibleWidth(swim.msg) - 3)
  let { pos, dir, bounces, round, msg } = swim
  pos += dir
  if (pos >= maxPos) {
    pos = maxPos
    dir = -1
    bounces += 1
  }
  if (pos <= 0) {
    pos = 0
    dir = 1
    bounces += 1
  }
  if (swim.liveThinking !== null) {
    msg = '💭 ' + swim.liveThinking
  } else if (bounces >= 2) {
    bounces = 0
    round += 1
    msg = nextQuip(round)
  }
  return { pos, dir, bounces, round, msg, liveThinking: swim.liveThinking }
}
