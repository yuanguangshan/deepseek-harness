import { describe, expect, it } from 'vitest'
import { createReducerState, reduceSessionEvent, type ReplEffect } from '../src/session-reducer.ts'
import { createStats, STREAM_FLUSH_MS, type ReplStats } from '../src/core.ts'

/** Apply a sequence of events to a fresh reducer/stats pair and collect all effects. */
function drive(events: ReadonlyArray<{ type: string; time: number; data?: unknown }>): ReplEffect[] {
  const state = createReducerState()
  const stats = createStats('p', 'm')
  const effects: ReplEffect[] = []
  for (const event of events) effects.push(...reduceSessionEvent(state, event, stats))
  return effects
}

const kinds = (effects: readonly ReplEffect[]): string[] => effects.map(e => e.kind)

describe('reduceSessionEvent — boundary events', () => {
  it('turn/start and step/start only feed stats (no UI effects)', () => {
    expect(drive([
      { type: 'turn/start', time: 0, data: {} },
      { type: 'step/start', time: 10, data: {} },
    ])).toEqual([])
  })
  it('ignores unknown event types via the default branch', () => {
    expect(drive([{ type: 'agent/inbox/spliced', time: 1, data: {} }])).toEqual([])
  })
})

describe('reduceSessionEvent — assistant/chunk', () => {
  it('appends text-delta and flushes on the first delta, then coalesces within the window', () => {
    const state = createReducerState()
    const stats = createStats('p', 'm')
    const t0 = 1_000
    const first = reduceSessionEvent(state, { type: 'assistant/chunk', time: t0, data: { chunk: { type: 'text-delta', text: 'hel' } } }, stats)
    // first delta: append + flush (cadence fires with no prior flush)
    expect(kinds(first)).toEqual(['appendAssistant', 'flushAssistant'])
    expect(state.pendingFlush).toBe(false)
    expect(state.lastFlushTime).toBe(t0)

    const within = reduceSessionEvent(state, { type: 'assistant/chunk', time: t0 + 1, data: { chunk: { type: 'text-delta', text: 'lo' } } }, stats)
    // within window: append only, flush is pending, lastFlushTime unchanged
    expect(kinds(within)).toEqual(['appendAssistant'])
    expect(state.pendingFlush).toBe(true)
    expect(state.lastFlushTime).toBe(t0)

    const later = reduceSessionEvent(state, { type: 'assistant/chunk', time: t0 + STREAM_FLUSH_MS, data: { chunk: { type: 'text-delta', text: '!' } } }, stats)
    // window elapsed: append + flush again
    expect(kinds(later)).toEqual(['appendAssistant', 'flushAssistant'])
  })
  it('appends reasoning-delta text but skips empty/whitespace-only reasoning', () => {
    expect(kinds(drive([
      { type: 'assistant/chunk', time: 1, data: { chunk: { type: 'reasoning-delta', text: '   ' } } },
    ]))).toEqual([])
    expect(kinds(drive([
      { type: 'assistant/chunk', time: 1, data: { chunk: { type: 'reasoning-delta', text: 'thinking' } } },
    ]))).toEqual(['appendThinking'])
  })
  it('ignores a non-object chunk and an unrecognized chunk type', () => {
    expect(drive([
      { type: 'assistant/chunk', time: 1, data: { chunk: null } },
      { type: 'assistant/chunk', time: 2, data: { chunk: { type: 'tool-call-delta', text: 'x' } } },
    ])).toEqual([])
  })
  it('opens a new assistant block (flushing pending) when a tool call split the text', () => {
    const state = createReducerState()
    const stats = createStats('p', 'm')
    reduceSessionEvent(state, { type: 'assistant/chunk', time: 1, data: { chunk: { type: 'text-delta', text: 'first' } } }, stats)
    // pend a flush without firing it
    reduceSessionEvent(state, { type: 'assistant/chunk', time: 2, data: { chunk: { type: 'text-delta', text: '!' } } }, stats)
    expect(state.lastFlushTime).toBe(1)
    reduceSessionEvent(state, { type: 'tool/call', time: 3, data: { name: 'bash', arguments: '{}' } }, stats)
    const afterTool = reduceSessionEvent(state, { type: 'assistant/chunk', time: 4, data: { chunk: { type: 'text-delta', text: 'second' } } }, stats)
    // pending flush fires, then newAssistantBlock, then append (same-time cadence does not re-flush)
    expect(kinds(afterTool)).toEqual(['flushAssistant', 'newAssistantBlock', 'appendAssistant'])
    expect(state.assistantDirty).toBe(false)
  })
})

describe('reduceSessionEvent — stats-rendering events', () => {
  it('assistant/message flushes pending text and renders stats', () => {
    const state = createReducerState()
    const stats = createStats('p', 'm')
    reduceSessionEvent(state, { type: 'assistant/chunk', time: 1, data: { chunk: { type: 'text-delta', text: 'a' } } }, stats)
    reduceSessionEvent(state, { type: 'assistant/chunk', time: 2, data: { chunk: { type: 'text-delta', text: 'b' } } }, stats)
    expect(state.pendingFlush).toBe(true)
    const msg = reduceSessionEvent(state, { type: 'assistant/message', time: 3, data: { message: { content: [] }, usage: { inputTokens: 1, outputTokens: 1 } } }, stats)
    expect(kinds(msg)).toEqual(['flushAssistant', 'renderStats'])
    expect(state.pendingFlush).toBe(false)
    expect(state.lastFlushTime).toBe(3)
  })
  it('assistant/message with no pending flush only renders stats', () => {
    expect(kinds(drive([{ type: 'assistant/message', time: 1, data: { message: { content: [] } } }]))).toEqual(['renderStats'])
  })
  it('request/context renders stats', () => {
    expect(kinds(drive([{ type: 'request/context', time: 1, data: { model: 'm', contextWindow: 1000 } }]))).toEqual(['renderStats'])
  })
})

describe('reduceSessionEvent — tool events', () => {
  it('tool/call describes args and marks the assistant block dirty', () => {
    const state = createReducerState()
    const stats = createStats('p', 'm')
    const eff = reduceSessionEvent(state, { type: 'tool/call', time: 1, data: { name: 'bash', arguments: '{"a":1}' } }, stats)
    expect(eff).toEqual([{ kind: 'toolCall', name: 'bash', args: '{"a":1}' }])
    expect(state.assistantDirty).toBe(true)
  })
  it('tool/call falls back to "?" for a missing name', () => {
    const eff = drive([{ type: 'tool/call', time: 1, data: { arguments: '{}' } }])
    expect(eff).toEqual([{ kind: 'toolCall', name: '?', args: '{}' }])
  })
  it('tool/result surfaces an isError block as an error summary', () => {
    const eff = drive([{ type: 'tool/result', time: 1, data: { message: { content: [{ type: 'text', text: 'boom', isError: true }] } } }])
    expect(eff).toEqual([{ kind: 'toolResult', summary: '✗ 工具返回错误', error: true }])
  })
  it('tool/result surfaces a text summary', () => {
    const eff = drive([{ type: 'tool/result', time: 1, data: { message: { content: [{ type: 'text', text: 'done' }] } } }])
    expect(eff).toEqual([{ kind: 'toolResult', summary: 'done', error: false }])
  })
  it('tool/result with no message surfaces data.error', () => {
    const eff = drive([{ type: 'tool/result', time: 1, data: { error: { code: 7 } } }])
    expect(eff).toEqual([{ kind: 'toolResult', summary: '✗ {"code":7}', error: true }])
  })
  it('tool/result with nothing falls back to a completion marker', () => {
    const eff = drive([{ type: 'tool/result', time: 1, data: {} }])
    expect(eff).toEqual([{ kind: 'toolResult', summary: '✓ 工具完成', error: false }])
  })
  it('tool/result renders stats only when the stats projection changed', () => {
    // a tool/result without a preceding tool/call does not change stats → no renderStats
    expect(kinds(drive([{ type: 'tool/result', time: 1, data: {} }]))).toEqual(['toolResult'])
    // with a preceding tool/call, the tool timing changes stats → renderStats precedes the result
    const eff = drive([
      { type: 'tool/call', time: 100, data: { name: 'bash', arguments: '{}' } },
      { type: 'tool/result', time: 1_300, data: { message: { content: [] } } },
    ])
    expect(kinds(eff)).toEqual(['toolCall', 'renderStats', 'toolResult'])
  })
})

describe('reduceSessionEvent — turn/end', () => {
  it('flushes pending, finishes the turn, and renders stats on normal completion', () => {
    const state = createReducerState()
    const stats = createStats('p', 'm')
    reduceSessionEvent(state, { type: 'assistant/chunk', time: 1, data: { chunk: { type: 'text-delta', text: 'a' } } }, stats)
    reduceSessionEvent(state, { type: 'assistant/chunk', time: 2, data: { chunk: { type: 'text-delta', text: 'b' } } }, stats)
    const end = reduceSessionEvent(state, { type: 'turn/end', time: 3, data: { reason: 'completed' } }, stats)
    expect(kinds(end)).toEqual(['flushAssistant', 'finishTurn', 'renderStats'])
    // scratch timing state cleared
    expect(stats.stepStart).toBeUndefined()
    expect(stats.decodeStart).toBeUndefined()
    expect(stats.toolStart).toBeUndefined()
  })
  it('reports an abnormal reason that was not a user interrupt', () => {
    const end = drive([{ type: 'turn/end', time: 1, data: { reason: { kind: 'max_tokens' } } }])
    expect(kinds(end)).toEqual(['abnormalTurnEnd', 'finishTurn', 'renderStats'])
    expect((end[0] as { reason: unknown }).reason).toEqual({ kind: 'max_tokens' })
  })
  it('suppresses the abnormal report when the user interrupted this turn', () => {
    const state = createReducerState()
    state.interruptRequested = true
    const stats = createStats('p', 'm')
    const end = reduceSessionEvent(state, { type: 'turn/end', time: 1, data: { reason: { kind: 'cancelled' } } }, stats)
    expect(kinds(end)).toEqual(['finishTurn', 'renderStats'])
    expect(state.interruptRequested).toBe(false)
  })
})

describe('reduceSessionEvent — error', () => {
  it('flushes pending, surfaces the error, and finishes the turn', () => {
    const end = drive([{ type: 'error', time: 1, data: { message: 'boom' } }])
    expect(kinds(end)).toEqual(['error', 'finishTurn'])
    expect((end[0] as { data: unknown }).data).toEqual({ message: 'boom' })
  })
})

describe('reduceSessionEvent — data tolerance', () => {
  it('treats a non-object event data as empty', () => {
    // tool/call with data:null → name '?' and args '' (no throw)
    const eff = reduceSessionEvent(createReducerState(), { type: 'tool/call', time: 1, data: null }, createStats())
    expect(eff).toEqual([{ kind: 'toolCall', name: '?', args: '' }])
  })
  it('reduceSessionEvent never mutates the caller-supplied data object shape', () => {
    const stats: ReplStats = createStats('p', 'm')
    const event = { type: 'turn/start', time: 1, data: {} }
    reduceSessionEvent(createReducerState(), event, stats)
    expect(stats.turns).toBe(1)
  })
})
