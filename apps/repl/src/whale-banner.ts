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
 * Two renderers:
 *  - {@link renderWhaleBanner}  — plain true-color text (1 pixel per cell).
 *  - {@link renderWhaleHalfBlock} — half-block `▀`/`▄` renderer (2 pixels per
 *    cell; foreground = upper pixel, background = lower). It packs each sprite
 *    row PAIR into ONE terminal row, so the 40×25 sprite shows as 40 cols ×
 *    13 rows of visually square, anti-aliased pixels — the "fully rendered"
 *    look from dsh-TUI. Returns plain strings, no terminal dependency.
 */

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
 * Render the whale sprite rows as a plain true-color text block (1 pixel per
 * cell). Trailing transparent cells are dropped per row so short rows hug the
 * left edge; every line closes its colors with RESET.
 */
export function renderWhaleBanner(rows: readonly string[] = WHALE_ROWS): string[] {
  return rows.map((line) => {
    const trimmed = line.replace(/\.+$/, '')
    let out = ''
    let openFg = ''
    for (const ch of trimmed) {
      const color = PALETTE[ch]
      if (color === undefined) {
        out += RESET + ' '
        openFg = ''
      } else {
        const code = fg(color)
        if (openFg !== code) {
          out += code
          openFg = code
        }
        out += ch
      }
    }
    return out + RESET
  })
}

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
    const upper = rows[r] ?? ''
    const lower = rows[r + 1] ?? ''
    let line = ''
    let current = ''
    for (let x = 0; x < upper.length; x++) {
      const upChar = upper[x]
      const loChar = lower[x]
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

/** A compact one-line whale for narrow status contexts (kept for parity). */
export function whaleDot(): string {
  return '\u{1F433}'
}
