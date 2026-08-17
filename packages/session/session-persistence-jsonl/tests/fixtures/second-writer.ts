/**
 * Second-writer child process for the ownership spec: mounts the given root,
 * resumes the named session, and appends the next contiguous turn.
 * Prints `appended` on success; exits 1 with the refusal message on stderr.
 */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

/**
 * A balanced one-turn log, event-for-event the spec's contract helper: the
 * child cannot import test-tree helpers, so the six events are restated here
 * and the spec pins the exact resulting count.
 */
function oneTurnLog(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 2, data: freezeMessage({
      id: MessageId('one-turn-user'),
      role: 'user',
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    }), surfaceOp: 'append' },
    { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 3, time: 4, data: {
      turn: 1, step: 1,
      message: freezeMessage({
        id: MessageId('one-turn-assistant'),
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, surfaceOp: 'append' },
    { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

function meta(id: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1000, cwd: '/work' }
}

const [root, id] = process.argv.slice(2)
if (root === undefined || id === undefined) {
  console.error('second-writer: expected <root> <session-id>')
  process.exit(1)
}

let ctx: Context | undefined
try {
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const loaded = await ctx.sessionPersistence.load(meta(id).id)
  const cont = oneTurnLog().map(event => ({ ...event, seq: event.seq + loaded.events.length }))
  await ctx.sessionPersistence.append(loaded.meta.id, cont)
  console.log(`appended ${cont.length}`)
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
}
