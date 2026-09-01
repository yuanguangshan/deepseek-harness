/**
 * Fuzzy session-content search for ctrl+r: score a query as a case-insensitive
 * subsequence of a text line (contiguous runs and word starts score higher),
 * and pull matching user/assistant lines out of one session's event log. The
 * REPL layers session ids and titles on top of these per-session hits.
 * @module @deepseek-ai/dsh-repl/fuzzy-search
 */

import { userMessageText, type SessionLogEvent } from './history.ts'

/** No match sentinel for {@link fuzzyScore}. */
export const NO_MATCH = -1

/**
 * Case-insensitive subsequence score. Returns {@link NO_MATCH} when the query
 * is not a subsequence of the text; otherwise higher is better — contiguous
 * matches and word-start hits beat scattered ones, earlier hits beat later.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLocaleLowerCase()
  const t = text.toLocaleLowerCase()
  if (q === '') return NO_MATCH
  let score = 0
  let ti = 0
  let prevHit = -2
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    if (ch === undefined || ch === ' ') continue
    const found = t.indexOf(ch, ti)
    if (found === -1) return NO_MATCH
    score += 1
    if (found === prevHit + 1) score += 2 // contiguous run
    if (found === 0 || /[\s\-_/.,;:!?'"()\[\]{}]/u.test(t[found - 1] ?? ' ')) score += 1 // word start
    prevHit = found
    ti = found + 1
  }
  return score + Math.max(0, 10 - Math.floor(ti / 20)) // earlier overall coverage wins
}

/** One matched line inside one session. */
export interface SessionSnippet {
  /** The matched line, trimmed to {@link formatSnippets}' width budget. */
  snippet: string
  score: number
}

/** Extract text lines worth searching from one session's events (user + assistant text). */
export function searchableLines(events: readonly SessionLogEvent[]): string[] {
  const lines: string[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      const text = userMessageText(event)
      if (text !== undefined) lines.push(text)
      continue
    }
    if (event.type === 'assistant/message') {
      const data = event.data
      if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
        const content = (data as Record<string, unknown>).content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block !== null && typeof block === 'object' && !Array.isArray(block)) {
              const b = block as Record<string, unknown>
              if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') lines.push(b.text)
            }
          }
        }
      }
    }
  }
  return lines
}

/** Find the best-scoring lines of one session for a query. */
export function findSnippets(events: readonly SessionLogEvent[], query: string, maxHits = 3): SessionSnippet[] {
  const hits: SessionSnippet[] = []
  for (const line of searchableLines(events)) {
    for (const rawLine of line.split('\n')) {
      const trimmed = rawLine.trim()
      if (trimmed === '') continue
      const score = fuzzyScore(query, trimmed)
      if (score !== NO_MATCH) hits.push({ snippet: trimmed, score })
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, maxHits)
}

/** Trim a snippet for picker display, keeping the match region roughly centered. */
export function clampSnippet(snippet: string, query: string, maxLen = 70): string {
  if (snippet.length <= maxLen) return snippet
  const idx = snippet.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase()[0] ?? '')
  const start = Math.max(0, Math.min(idx - 10, snippet.length - maxLen))
  return `${start > 0 ? '…' : ''}${snippet.slice(start, start + maxLen)}…`
}
