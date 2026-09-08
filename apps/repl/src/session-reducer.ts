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
  /** The `todo/write` whole-list snapshot: the model's task checklist for this turn. */
  | { readonly kind: 'todoWrite'; readonly todos: readonly TodoView[] }
  /** A `goal/change` snapshot: the active goal (if any) and its progress. */
  | { readonly kind: 'goalChange'; readonly goal: GoalView | undefined; readonly roundsStarted: number }

/** Lightweight view of one todo item rendered on the status line. */
export interface TodoView {
  readonly content: string
  readonly status: string
}

/** Lightweight view of the active goal, pruned to what the status line shows. */
export interface GoalView {
  readonly objective: string
  readonly phase: string
  readonly maxGoalRounds: number | undefined
  readonly blockedReason: string | undefined
}

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

  /** 应用单个 assistant/chunk 的 chunk 载荷（block-start/text-delta/reasoning-delta/block-end）。 */
  const applyChunkPayload = (chunk: unknown): void => {
    if (chunk !== null && typeof chunk === 'object') {
      const c = chunk as Record<string, unknown>
      if (c.type === 'block-start') {
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
          if (state.assistantDirty) {
            flushIfPending()
            effects.push({ kind: 'newAssistantBlock' })
            state.assistantDirty = false
          }
          if (state.blockHasDelta) {
            replaceDelta(block.text)
          } else {
            appendDelta(block.text)
          }
          state.blockHasDelta = false
        }
      }
    }
  }

  /** 应用 alpha.2 assistant/attempt 内嵌的流片段（chunk 包装项与 text-chunks 批量项混排）。 */
  const applyStreamItem = (item: unknown): void => {
    if (item !== null && typeof item === 'object' && (item as Record<string, unknown>).type === 'text-chunks') {
      const texts = (item as Record<string, unknown>).texts
      if (Array.isArray(texts)) {
        for (const t of texts) {
          if (typeof t === 'string' && t !== '') {
            if (state.assistantDirty) {
              flushIfPending()
              effects.push({ kind: 'newAssistantBlock' })
              state.assistantDirty = false
            }
            state.blockHasDelta = true
            appendDelta(t)
          }
        }
      }
      return
    }
    const chunk = (item as Record<string, unknown> | undefined)?.chunk
    applyChunkPayload(chunk)
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
      applyChunkPayload(data.chunk)
      break
    }
    case 'assistant/attempt': {
      // alpha.2：整段流内嵌在事件的 stream 数组里（chunk 包装项与 text-chunks 项混排）。
      statsOnEvent(stats, event)
      const stream = (data as { stream?: unknown }).stream
      if (Array.isArray(stream)) for (const item of stream) applyStreamItem(item)
      break
    }
    case 'text-chunks': {
      // alpha.2 批量文本事件：texts 数组按序视同 text-delta 片段。
      statsOnEvent(stats, event)
      const texts = (data as { texts?: unknown }).texts
      if (Array.isArray(texts)) {
        for (const t of texts) {
          if (typeof t === 'string' && t !== '') {
            if (state.assistantDirty) {
              flushIfPending()
              effects.push({ kind: 'newAssistantBlock' })
              state.assistantDirty = false
            }
            appendDelta(t)
          }
        }
      }
      break
    }
    case 'assistant/message': {
      statsOnEvent(stats, event)
      // alpha.2：完整流内嵌在 message 事件的 stream 数组里（block-start →
      // text-chunks → block-end → finish），先重放再冲刷统计。
      const stream = (data as { stream?: unknown }).stream
      if (Array.isArray(stream)) for (const item of stream) applyStreamItem(item)
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
      stats.currentToolName = ''
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
      stats.currentToolName = ''
      effects.push({ kind: 'error', data })
      effects.push({ kind: 'finishTurn' })
      break
    }
    case 'todo/write': {
      // Whole-list replacement from the model's todo_write tool: render the
      // task checklist on the status line so the user sees what step is live.
      const raw = data.todos
      const todos: TodoView[] = Array.isArray(raw)
        ? raw
          .filter((t): t is Record<string, unknown> => t !== null && typeof t === 'object')
          .map(t => ({
            content: (typeof t.content === 'string' ? t.content : '').trim(),
            status: typeof t.status === 'string' ? t.status : 'pending',
          }))
          .filter(t => t.content !== '')
        : []
      effects.push({ kind: 'todoWrite', todos })
      break
    }
    case 'goal/change': {
      // A goal mutation snapshot: surface the active goal (objective/phase/progress).
      const goalData = data.goal
      const goal: GoalView | undefined =
        goalData !== null && typeof goalData === 'object'
          ? (() => {
            const g = goalData as Record<string, unknown>
            const budget = g.maxGoalRounds
            const blocked = g.blockedReason
            return {
              objective: typeof g.objective === 'string' ? g.objective : '',
              phase: typeof g.phase === 'string' ? g.phase : 'active',
              maxGoalRounds: typeof budget === 'number' ? budget : undefined,
              blockedReason: blocked !== null && blocked !== undefined && typeof blocked === 'object'
                && typeof (blocked as Record<string, unknown>).message === 'string'
                ? (blocked as Record<string, unknown>).message as string
                : typeof blocked === 'string' ? blocked : undefined,
            }
          })()
          : undefined
      effects.push({
        kind: 'goalChange',
        goal,
        roundsStarted: typeof data.roundsStarted === 'number' ? data.roundsStarted : 0,
      })
      break
    }
    default:
      break
  }
  return effects
}
