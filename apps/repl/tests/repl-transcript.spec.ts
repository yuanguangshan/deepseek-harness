import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { HarnessClient, type HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import { createStats, type ReplStats } from '../src/core.ts'
import { createReducerState, reduceSessionEvent, type ReplEffect, type ReplReducerState } from '../src/session-reducer.ts'

// The scripted fake runtime (no model, no network, no harness imports) speaks the runtime's
// newline-delimited JSON-RPC protocol, streaming scripted session.event notifications. Pointing a
// real HarnessClient at it drives the same wire path the TUI uses, with no API key. Node's native
// type stripping runs the .ts runtime directly — the same pattern as the SDK client's own suite.
const fakeRuntime = fileURLToPath(new URL('../../../packages/sdk/client/tests/fake-runtime.ts', import.meta.url))

/** Drive one scripted turn through a real client and reduce every session.event into effects. */
async function runTurn(env: Record<string, string>): Promise<ReplEffect[]> {
  const client = new HarnessClient({ command: process.execPath, args: [fakeRuntime], cwd: process.cwd(), env: { ...process.env, ...env } })
  try {
    client.start()
    await client.initialize({ cwd: process.cwd(), provider: 'fake', model: 'fake' })
    // Subscribe before the prompt: the fake runtime streams session.event notifications while
    // answering session/prompt, and a subscription registered afterward misses them.
    const sub = client.subscribeSessionTree('repl-snapshot')
    const reducerState = createReducerState()
    const stats = createStats('fake', 'fake')
    const effects: ReplEffect[] = []
    const drained = new Promise<void>((resolve) => {
      void (async () => {
        for await (const n of sub) {
          if (collect(n, reducerState, stats, effects)) { resolve(); break }
        }
        resolve()
      })()
    })
    await client.prompt('repl-snapshot', [{ type: 'text', text: 'ping' }])
    await Promise.race([drained, new Promise(resolve => setTimeout(resolve, 2_000))])
    sub.close()
    return effects
  } finally {
    await client.close()
  }
}

/** Reduce one notification; returns true once the turn ended. */
function collect(
  n: HarnessNotification,
  state: ReplReducerState,
  stats: ReplStats,
  effects: ReplEffect[],
): boolean {
  if (n.method !== 'session.event') return false
  const params = n.params as { sessionId?: unknown; event?: unknown }
  const event = params.event
  if (event === null || typeof event !== 'object') return false
  effects.push(...reduceSessionEvent(state, event as { type: string; time: number; data?: unknown }, stats))
  return (event as { type?: string }).type === 'turn/end'
}

describe('repl transcript (keyless, real wire)', () => {
  it('reduces a streamed happy-path turn into the expected effect sequence', async () => {
    const effects = await runTurn({ FAKE_TEXT: 'hello world' })
    const kinds = effects.map(e => e.kind)
    // turn/start → chunk(text-delta) flushes (first delta) → assistant/message flushes nothing
    // pending (already flushed) but renders stats → turn/end renders stats + finishes.
    expect(kinds).toContain('appendAssistant')
    expect(kinds).toContain('flushAssistant')
    expect(kinds.filter(k => k === 'appendAssistant')).toHaveLength(1)
    // the appended text reaches the model output
    expect((effects.find(e => e.kind === 'appendAssistant') as { text?: string })?.text).toBe('hello world')
    // every turn terminates with finishTurn
    expect(kinds.at(-1)).toBe('renderStats')
    expect(kinds).toContain('finishTurn')
  })

  it('reports an abnormal turn/end reason without a user interrupt', async () => {
    const effects = await runTurn({ FAKE_TEXT: 'too long', FAKE_REASON_KIND: 'max_tokens' })
    const abnormal = effects.find(e => e.kind === 'abnormalTurnEnd') as { reason?: unknown } | undefined
    expect(abnormal).toBeDefined()
    expect(abnormal?.reason).toEqual({ kind: 'max_tokens' })
    expect(effects.map(e => e.kind)).toContain('finishTurn')
  })
})
