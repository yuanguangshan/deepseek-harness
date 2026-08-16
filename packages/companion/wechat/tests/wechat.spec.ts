import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import * as tool from '../src/index.ts'

// The dispatcher spawns the host-side send script; the tests substitute a fake
// child so no real Python or WeChat channel is needed.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: ReturnType<typeof vi.fn>
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn()
    spawnMock(...args, child)
    return child
  },
}))

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool)
  return ctx
}

function call(ctx: Context, text: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`wechat-${Math.random().toString(36).slice(2)}`),
    name: 'wechat_send',
    arguments: { text },
  })
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** The last fake child the mocked spawn handed to the spy. */
function lastChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> } {
  const child = spawnMock.mock.calls.at(-1)?.[3] as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
  } | undefined
  if (child === undefined) throw new Error('no child spawned')
  return child
}

describe('wechat tool', () => {
  it('registers wechat_send with a model-facing description', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(s => s.name === 'wechat_send')
    expect(schema).toBeDefined()
    expect(schema!.description).toContain('Send a plain-text message to WeChat')
    expect(schema!.parameters).toMatchObject({
      properties: { text: { type: 'string', description: 'The message text to send to WeChat.' } },
      required: ['text'],
    })
  })

  it('rejects a whitespace-only message without spawning', async () => {
    const ctx = await setup()
    const result = await call(ctx, '   ')
    expect(textOf(result)).toBe('没有可发送的内容（空文本）')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('spawns the send script with --weclaw-first and reports the channel on success', async () => {
    const ctx = await setup()
    const pending = call(ctx, 'hello 微信')
    await vi.waitFor(() => { expect(spawnMock).toHaveBeenCalled() })
    const child = lastChild()
    expect(spawnMock).toHaveBeenCalledWith(
      'python3',
      [expect.stringContaining('wechat-send'), 'hello 微信', '--weclaw-first'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
      expect.anything(),
    )
    child.stdout.emit('data', Buffer.from('✅ channel=weclaw, sent\n'))
    child.emit('close', 0)
    expect(textOf(await pending)).toBe('已发送到微信（channel=weclaw）')
  })

  it('reports the script stderr on a non-zero exit', async () => {
    const ctx = await setup()
    const pending = call(ctx, 'hello')
    await vi.waitFor(() => { expect(spawnMock).toHaveBeenCalled() })
    const child = lastChild()
    child.stderr.emit('data', Buffer.from('weixinpush quota exhausted'))
    child.emit('close', 1)
    expect(textOf(await pending)).toContain('weixinpush quota exhausted')
  })

  it('reports a failed send when the script exits with no output', async () => {
    const ctx = await setup()
    const pending = call(ctx, 'hello')
    await vi.waitFor(() => { expect(spawnMock).toHaveBeenCalled() })
    const child = lastChild()
    child.emit('close', 1)
    expect(textOf(await pending)).toBe('发送失败：脚本无输出（微信配额或通道不可用？）')
  })

  it('reports an invocation failure when the script cannot start', async () => {
    const ctx = await setup()
    const pending = call(ctx, 'hello')
    await vi.waitFor(() => { expect(spawnMock).toHaveBeenCalled() })
    const child = lastChild()
    child.emit('error', new Error('ENOENT'))
    expect(textOf(await pending)).toContain('发送失败：无法调用')
    expect(textOf(await pending)).toContain('ENOENT')
  })

  it('kills a stuck script after the 30-second budget', async () => {
    vi.useFakeTimers()
    try {
      const ctx = await setup()
      void call(ctx, 'hello')
      await vi.advanceTimersByTimeAsync(0)
      for (let i = 0; i < 10 && spawnMock.mock.calls.length === 0; i += 1) await Promise.resolve()
      const child = lastChild()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('unregisters the tool when the contributing fiber is disposed (HMR-safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(tool)
    expect(ctx.tools.schemas().some(s => s.name === 'wechat_send')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'wechat_send')).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('wechat')
    expect(tool.inject).toEqual(['tools'])
  })
})
