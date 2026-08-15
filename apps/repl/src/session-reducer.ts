/**
 * Pure session-event reducer for the REPL TUI.
 *
 * The only assertion-worthy behavior in the terminal front-end is the mapping from
 * `session.event` notifications to UI effects (assistant text accumulation, thinking
 * lines, tool cards, stats, abnormal turn/end, the streaming-flush cadence). Extracting
 * it as a pure `(state, event, stats) → effects` function lets the reducer reach per-file
 * 100% coverage and be driven by a keyless scripted runtime without a PTY, while the
 * terminal glue (alt-screen, raw stdin, widget rendering) stays thin and coverage-excluded.
 *
 * The reducer accumulates deltas but never renders them: it emits `flushAssistant` at most
 * once per {@link STREAM_FLUSH_MS} of event time, plus on every terminal transition
 * (`assistant/message`, `turn/end`, a new assistant block after a tool call). That invariant
 * keeps the final rendered text complete without re-parsing the whole buffer on every delta.
 */
import { describeToolArgs, isAbnormalTurnEnd, shouldFlushStream, statsOnEvent, summarizeToolResult, type ReplStats, type StatsEvent } from './core.ts'

/** One UI effect produced by applying a session event. */
export type ReplEffect =
  | { readonly kind: 'appendAssistant'; readonly text: string }
  | { readonly kind: 'replaceAssistant'; readonly text: string }
  | { readonly kind: 'appendThinking'; readonly text: string }
  | { readonly kind: 'flushAssistant' }
  | { readonly kind: 'newAssistantBlock' }
  | { readonly kind: 'toolCall'; readonly name: string; readonly args: string }
  | { readonly kind: 'toolResult'; readonly summary: string; readonly error: boolean }
  | { readonly kind: 'abnormalTurnEnd'; readonly reason: unknown }
  | { readonly kind: 'renderStats' }
  | { readonly kind: 'finishTurn' }
  | { readonly kind: 'error'; readonly data: unknown }

/** Mutable reducer state carried across events within a turn. */
export interface ReplReducerState {
  /** A tool call split the assistant text; the next assistant chunk opens a fresh block. */
  assistantDirty: boolean
  /** Buffered assistant text is unflushed: a terminal transition must render it. */
  pendingFlush: boolean
  /** Event time of the last assistant flush, or undefined before the first flush. */
  lastFlushTime: number | undefined
  /** Whether the current turn was interrupted by the user (ESC) before its turn/end. */
  interruptRequested: boolean
  /**
   * Whether the current open text block has already streamed at least one text-delta. A real
   * provider emits text blocks as `block-start → block-end` carrying the authoritative full text
   * (almost no text-delta), while delta-only adapters (tests, streaming providers) stream
   * `text-delta` fragments. `block-end` must render the full text once: append it for a fresh
   * block, or replace the streamed fragments when deltas already rendered that block. Reset by
   * each text `block-start`.
   */
  blockHasDelta: boolean
}

/** Create fresh reducer state for a new turn. */
export function createReducerState(): ReplReducerState {
  return { assistantDirty: false, pendingFlush: false, lastFlushTime: undefined, interruptRequested: false, blockHasDelta: false }
}

/** Event data accessor that tolerates missing/non-object `data`. */
function dataOf(event: StatsEvent): Record<string, unknown> {
  const data = event.data
  return data !== null && typeof data === 'object' ? data as Record<string, unknown> : {}
}

/**
 * Reduce one session event into UI effects, applying timing/usage to `stats` in place.
 *
 * Terminal transitions always emit `flushAssistant` (when a flush is pending) before the
 * transition effect, so the buffered assistant text is rendered complete at turn end.
 * @returns the effects to apply; never throws.
 */
export function reduceSessionEvent(state: ReplReducerState, event: StatsEvent, stats: ReplStats): ReplEffect[] {
  const effects: ReplEffect[] = []
  const data = dataOf(event)

  /** Render any buffered assistant text now, recording the flush time. */
  const flushIfPending = (): void => {
    if (state.pendingFlush) {
      effects.push({ kind: 'flushAssistant' })
      state.pendingFlush = false
      state.lastFlushTime = event.time
    }
  }

  /** Buffer a text delta and flush at the coalesce cadence. */
  const appendDelta = (text: string): void => {
    effects.push({ kind: 'appendAssistant', text })
    state.pendingFlush = true
    if (shouldFlushStream(event.time, state.lastFlushTime)) {
      effects.push({ kind: 'flushAssistant' })
      state.pendingFlush = false
      state.lastFlushTime = event.time
    }
  }

  /** Replace the accumulated assistant text with the authoritative full block (see block-end). */
  const replaceDelta = (text: string): void => {
    effects.push({ kind: 'replaceAssistant', text })
    state.pendingFlush = true
    if (shouldFlushStream(event.time, state.lastFlushTime)) {
      effects.push({ kind: 'flushAssistant' })
      state.pendingFlush = false
      state.lastFlushTime = event.time
    }
  }

  switch (event.type) {
    case 'turn/start': {
      statsOnEvent(stats, event)
      state.blockHasDelta = false
      break
    }
    case 'step/start': {
      statsOnEvent(stats, event)
      break
    }
    case 'assistant/chunk': {
      statsOnEvent(stats, event)
      const chunk = data.chunk
      if (chunk !== null && typeof chunk === 'object') {
        const c = chunk as Record<string, unknown>
        if (c.type === 'block-start') {
          // Each text block is one assistant message; start fresh for it. Reset the
          // blockHasDelta marker so the eventual block-end can decide append vs replace.
          if (c.blockType === 'text') state.blockHasDelta = false
        } else if (c.type === 'text-delta' && typeof c.text === 'string') {
          state.blockHasDelta = true
          if (state.assistantDirty) {
            flushIfPending()
            effects.push({ kind: 'newAssistantBlock' })
            state.assistantDirty = false
          }
          appendDelta(c.text)
        } else if (c.type === 'reasoning-delta' && typeof c.text === 'string' && c.text.trim() !== '') {
          effects.push({ kind: 'appendThinking', text: c.text })
        } else if (c.type === 'block-end' && c.block !== null && typeof c.block === 'object') {
          const block = c.block as Record<string, unknown>
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
            // A tool call split the assistant text; open a fresh block like text-delta does.
            if (state.assistantDirty) {
              flushIfPending()
              effects.push({ kind: 'newAssistantBlock' })
              state.assistantDirty = false
            }
            if (state.blockHasDelta) {
              // This block was already streamed via text-deltas; the block-end full text is the
              // authoritative version — replace the fragments so the reply renders exactly once.
              replaceDelta(block.text)
            } else {
              // Delta-only providers never emit text-delta; the block-end full text is the whole reply.
              appendDelta(block.text)
            }
            state.blockHasDelta = false
          }
          // tool-call / reasoning block-ends stay inert: their visible parts arrive via
          // tool-call-delta / tool/call / reasoning-delta.
        }
      }
      break
    }
    case 'assistant/message': {
      statsOnEvent(stats, event)
      flushIfPending()
      effects.push({ kind: 'renderStats' })
      break
    }
    case 'request/context': {
      statsOnEvent(stats, event)
      effects.push({ kind: 'renderStats' })
      break
    }
    case 'tool/call': {
      statsOnEvent(stats, event)
      state.assistantDirty = true
      effects.push({ kind: 'toolCall', name: typeof data.name === 'string' ? data.name : '?', args: describeToolArgs(data.arguments) })
      break
    }
    case 'tool/result': {
      if (statsOnEvent(stats, event)) effects.push({ kind: 'renderStats' })
      const { summary, error } = summarizeToolResult(data)
      if (error) effects.push({ kind: 'toolResult', summary: '✗ 工具返回错误', error: true })
      else if (summary !== '') effects.push({ kind: 'toolResult', summary, error: false })
      else if (data.error !== undefined) effects.push({ kind: 'toolResult', summary: `✗ ${JSON.stringify(data.error)}`, error: true })
      else effects.push({ kind: 'toolResult', summary: '✓ 工具完成', error: false })
      break
    }
    case 'turn/end': {
      const reason = data.reason
      const wasUserInterrupt = state.interruptRequested
      state.interruptRequested = false
      state.assistantDirty = false
      flushIfPending()
      if (isAbnormalTurnEnd(reason) && !wasUserInterrupt) {
        effects.push({ kind: 'abnormalTurnEnd', reason })
      }
      stats.stepStart = undefined
      stats.decodeStart = undefined
      stats.toolStart = undefined
      stats.livePhase = 'idle' // drop the "作答中/思考中/工具调用中" live segment — nothing is running
      effects.push({ kind: 'finishTurn' })
      effects.push({ kind: 'renderStats' })
      break
    }
    case 'error': {
      state.assistantDirty = false
      state.interruptRequested = false
      flushIfPending()
      stats.stepStart = undefined
      stats.decodeStart = undefined
      stats.toolStart = undefined
      stats.livePhase = 'idle' // the turn died mid-flight; clear the stale live phase
      effects.push({ kind: 'error', data })
      effects.push({ kind: 'finishTurn' })
      break
    }
    default:
      break
  }
  return effects
}
