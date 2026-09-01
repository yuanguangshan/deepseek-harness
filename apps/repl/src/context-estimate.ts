/**
 * `/context` estimate: a rough token breakdown of the current session's
 * persisted event log. The runtime owns the real tokenizer; this module gives
 * an order-of-magnitude view (chars/4 heuristic, labeled as such) so the user
 * can see what dominates their context before it gets compacted.
 * @module @deepseek-ai/dsh-repl/context-estimate
 */

import { userMessageText, type SessionLogEvent } from './history.ts'

/** Heuristic chars-per-token ratio for mixed CJK/English text (labeled as estimate). */
export const CHARS_PER_TOKEN = 4

/** One labeled section of the breakdown. */
export interface ContextSection {
  label: string
  tokens: number
}

/** Text length of one content-blocks `data` record (`text` blocks only). */
function contentTextLength(data: unknown): number {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return 0
  const content = (data as Record<string, unknown>).content
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (block !== null && typeof block === 'object' && !Array.isArray(block)) {
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') total += b.text.length
    }
  }
  return total
}

/** Rough token estimate for one section's char count. */
const tokensOf = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN)

/**
 * Bucket the event log into labeled sections and estimate tokens for each.
 * User text, system injections (user-role messages without user text), assistant
 * text, tool arguments/results, and everything else are tracked separately.
 */
export function estimateContextBreakdown(events: readonly SessionLogEvent[]): ContextSection[] {
  let userChars = 0
  let injectedChars = 0
  let assistantChars = 0
  let toolChars = 0
  let otherChars = 0
  for (const event of events) {
    const data = event.data
    switch (event.type) {
      case 'user/message': {
        const text = userMessageText(event)
        if (text !== undefined) userChars += text.length
        else injectedChars += contentTextLength(data)
        break
      }
      case 'assistant/message':
      case 'assistant/chunk': {
        assistantChars += contentTextLength(data)
        break
      }
      case 'tool/call':
      case 'tool/result': {
        if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
          toolChars += JSON.stringify(data).length
        }
        break
      }
      default: {
        if (data !== undefined) otherChars += JSON.stringify(data).length
      }
    }
  }
  return [
    { label: '用户消息', tokens: tokensOf(userChars) },
    { label: '系统注入', tokens: tokensOf(injectedChars) },
    { label: '助手回复', tokens: tokensOf(assistantChars) },
    { label: '工具调用/结果', tokens: tokensOf(toolChars) },
    { label: '其他事件', tokens: tokensOf(otherChars) },
  ]
}

/** Horizontal ▓/░ bar of `width` cells for a share of `total`. */
function bar(tokens: number, total: number, width = 24): string {
  const filled = total === 0 ? 0 : Math.max(tokens === 0 ? 0 : 1, Math.round(tokens / total * width))
  return '▓'.repeat(Math.min(width, filled)) + '░'.repeat(Math.max(0, width - filled))
}

/** Render the breakdown: largest section first, plus a chars/4 estimate disclaimer. */
export function formatContextBreakdown(sections: readonly ContextSection[], contextWindow?: number): string {
  const total = sections.reduce((sum, s) => sum + s.tokens, 0)
  const sorted = [...sections].sort((a, b) => b.tokens - a.tokens)
  const lines = sorted.map(s =>
    `  ${s.label.padEnd(8, '　')} ${bar(s.tokens, total)} ${String(s.tokens).padStart(6)} tok`)
  const head = `📏 会话上下文估算（合计 ≈${total} tokens · chars/4 粗估）`
  const tail = contextWindow !== undefined
    ? `  上下文窗口 ${contextWindow} · 已用约 ${(total / contextWindow * 100).toFixed(1)}% · /compact 可手动压缩`
    : '  /compact 可手动压缩会话'
  return [head, ...lines, tail].join('\n')
}
