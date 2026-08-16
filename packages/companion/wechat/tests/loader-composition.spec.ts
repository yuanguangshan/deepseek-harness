// Proves dsh-wechat is a real composition plugin: a cordis.yml booted through
// the real Loader registers `wechat_send`, and executing it dispatches to the
// host-side send script (substituted with a fake child so no Python or WeChat
// channel is needed).
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import * as Wechat from '../src/index.ts'

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

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml mounting dsh-tools + dsh-wechat.
 * @param tempRoot - the temp directory owning cordis.yml (also the afterEach cleanup target).
 * @returns the booted context.
 */
async function boot(tempRoot: string): Promise<Context> {
  const configPath = join(tempRoot, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    '- id: wechat',
    "  name: '@deepseek-ai/dsh-wechat'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(tempRoot).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-wechat', Wechat],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

function call(ctx: Context, text: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('wechat-loader'),
    name: 'wechat_send',
    arguments: { text },
  })
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('dsh-wechat real Loader composition through cordis.yml', () => {
  it('registers wechat_send and executes it against the send script', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-wechat-loader-'))
    const ctx = await boot(root)
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('wechat_send')

    const pending = call(ctx, '来自 loader 的消息')
    await vi.waitFor(() => { expect(spawnMock).toHaveBeenCalled() })
    const child = spawnMock.mock.calls.at(-1)?.[3] as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: ReturnType<typeof vi.fn>
    }
    child.stdout.emit('data', Buffer.from('✅ channel=weixinpush, sent\n'))
    child.emit('close', 0)
    expect(resultText(await pending)).toBe('已发送到微信（channel=weixinpush）')
  }, 30_000)
})
