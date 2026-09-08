import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as commandTitle from '@deepseek-ai/dsh-command-title'

/** The shared title-service config the example spine mounts (its schema requires explicit values). */
const TITLE_CONFIG = { fallbackMaxWords: 6, fallbackMaxBytes: 60, maxTitleBytes: 120 }

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

/** Build a live idle agent accepted by the exact-identity title service. */
async function stubAgent(ctx: Context, id: string): Promise<{ agent: Agent; session: Session }> {
  const session = ctx.sessions.create(SessionId(id))
  const inbox = createInboxStub()
  let status: AgentStatus = 'idle'
  const agent = {} as Agent
  let innerCtx!: Context
  // alpha.2 的命令层按 agent 的 ctx 链解析：agent 必须挂在 command-injected
  // 插件作用域下，root 层注册的全局命令才对其可见（对齐上游 mintAgentScope）。
  await ctx.plugin(Object.assign((inner: Context) => { innerCtx = inner; createScope(inner, agent) }, { inject: ['commands'] }))
  const full: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: innerCtx,
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { inbox.append('next-step', input) },
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  Object.assign(agent, full)
  ctx.agents.register(agent)
  return { agent, session }
}

/** Mount the real command registry, session store, and title service. */
async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  // alpha.2：SessionTitleService 依赖 sessionProjections 服务，必须先挂载投影注册表，
  // 否则其注入无法激活、command-title（依赖 sessionTitle）跟着整条不激活、/rename 不注册。
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionTitleService, TITLE_CONFIG)
  const plugin = await ctx.plugin(commandTitle)
  // createScope 内部已完成 ctx.agents.register，无需显式注册
  const { agent, session } = await stubAgent(ctx, `command-title-${Math.random()}`)
  return { ctx, agent, session, plugin }
}

/** Execute `/rename` through the same registry boundary as a UI adapter. */
async function run(test: Harness, suffix = ''): Promise<NonNullable<Awaited<ReturnType<CommandRuntime['execute']>>>['result']> {
  const execution = await test.ctx.commands.execute(
    test.agent,
    `/rename${suffix}`,
    [],
    new AbortController().signal,
  )
  if (execution === undefined) throw new Error('rename command was not registered')
  return execution.result
}

/** Executor-owned lifecycle bookkeeping stripped (assertions target title events). */
function domainEvents(session: Session): readonly SessionEvent[] {
  return session.ownEvents().filter(event => event.type !== 'command/run' && event.type !== 'command/done')
}

// 历史遗留：0.1.1-rc.1 基线时 SessionTitleService 不依赖 sessionProjections，
// 升级 alpha.2 后该依赖链未同步到本 harness，导致 sessionTitle 服务整条不激活、
// /rename 不注册。已通过 harness 补挂 SessionProjectionRegistry 修复。
describe('@deepseek-ai/dsh-command-title registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    const test = await harness()
    expect(commandTitle.name).toBe('command-title')
    expect(commandTitle.inject).toEqual(['commands', 'sessionTitle'])
    expect('default' in commandTitle).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandTitle)).toBe(commandTitle)

    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      name: 'rename',
      description: 'rename the current session (pins the title; automatic generation stops)',
      input: { hint: '<new title>' },
    })
    expect(test.ctx.commands.find(test.agent, 'rename')).toBeDefined()

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'rename')).toBeUndefined()
  })
})

describe('/rename human command', () => {
  it('sets the title and appends one user-sourced title event', async () => {
    const test = await harness()
    await expect(run(test, '  fix the login bug  ')).resolves.toEqual({
      kind: 'success',
      text: 'Title set: fix the login bug',
    })
    const titleEvents = domainEvents(test.session).filter(event => event.type === 'session/title')
    expect(titleEvents).toHaveLength(1)
    const data = titleEvents[0]?.data as { title: string; source: { kind: string } }
    expect(data.title).toBe('fix the login bug')
    expect(data.source.kind).toBe('user')
    expect(test.ctx.sessionTitle.get(test.agent.session)?.title).toBe('fix the login bug')
  })

  it('rejects an empty title with usage', async () => {
    const test = await harness()
    await expect(run(test, '')).resolves.toEqual({
      kind: 'error',
      text: 'Usage: /rename <new title>',
    })
    await expect(run(test, '   ')).resolves.toEqual({
      kind: 'error',
      text: 'Usage: /rename <new title>',
    })
    expect(domainEvents(test.session)).toEqual([])
  })

  it('rejects a whitespace-only title as empty through the domain validation', async () => {
    // `\u0007` is stripped by normalization, collapsing to empty → invalid.
    const test = await harness()
    const result = await run(test, ' \u0007 ')
    expect(result.kind).toBe('error')
    expect(domainEvents(test.session)).toEqual([])
  })

  it('rethrows errors that are not SessionTitleInvalidError', async () => {
    // Swap the sessionTitle service's rename implementation (the executor must
    // propagate unexpected failures unchanged instead of swallowing them).
    const test = await harness()
    const original = test.ctx.sessionTitle.rename.bind(test.ctx.sessionTitle)
    test.ctx.sessionTitle.rename = () => { throw new Error('storage exploded') }
    try {
      await expect(run(test, ' some title')).rejects.toThrow('storage exploded')
    } finally {
      test.ctx.sessionTitle.rename = original
    }
    expect(domainEvents(test.session)).toEqual([])
  })
})
