// Proves the tool-companion config keys are real configurability and not
// constants: a cordis.yml booted through the real Loader points the memory
// store and the ZCode config at temp paths, and both tools follow them.
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

import * as ToolCompanion from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Boot a cordis.yml mounting dsh-tools + dsh-tool-companion with the given
 * config lines.
 * @param memoryRoot - the temp directory owning cordis.yml (also the afterEach cleanup target).
 * @param configLines - YAML lines nested under the tool's `config:` key.
 * @returns the booted context.
 */
async function boot(memoryRoot: string, configLines: readonly string[]): Promise<Context> {
  const configPath = join(memoryRoot, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    '- id: tool-companion',
    "  name: '@deepseek-ai/dsh-tool-companion'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(memoryRoot).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-companion', ToolCompanion],
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

function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`companion-loader-${name}`),
    name,
    arguments: args,
  })
}

describe('tool-companion real Loader composition through cordis.yml', () => {
  it('registers both tools and executes memory against the configured directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-tool-companion-loader-'))
    const memoryDir = join(root, 'memory')
    const ctx = await boot(root, [
      `    memoryDir: ${JSON.stringify(memoryDir)}`,
      `    zcodeConfigPath: ${JSON.stringify(join(root, 'absent.json'))}`,
    ])
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('memory')
    expect(names).toContain('usage_status')

    const added = await call(ctx, 'memory', { op: 'add', target: 'memory', content: 'via loader' })
    expect(resultText(added)).toBe('Recorded to memory track.')
    const entries = await call(ctx, 'memory', { op: 'entries', target: 'memory' })
    expect(resultText(entries)).toContain('via loader')

    const { readFile } = await import('node:fs/promises')
    expect(await readFile(join(memoryDir, 'memory.md'), 'utf8')).toContain('via loader')
  }, 30_000)

  it('executes usage_status against the configured ZCode config', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-tool-companion-loader-'))
    const zcodePath = join(root, 'zcode.json')
    await writeFile(zcodePath, JSON.stringify({
      provider: {
        opencode: {
          name: 'opencode go', options: { baseURL: 'https://opencode.ai/zen/go/v1', apiKey: 'sk-test' },
        },
      },
    }), 'utf8')
    vi.stubGlobal('fetch', async (_url: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({
        usage: {
          rolling: { status: 'ok', percent: 10, resetsAt: '2026-08-14T13:59:12Z' },
          weekly: { status: 'ok', percent: 57, resetsAt: '2026-08-17T00:00:00Z' },
          monthly: { status: 'ok', percent: 31, resetsAt: '2026-09-05T11:37:11Z' },
        },
      }),
    }))
    const ctx = await boot(root, [`    zcodeConfigPath: ${JSON.stringify(zcodePath)}`])
    const result = await call(ctx, 'usage_status', {})
    expect(resultText(result)).toContain('OC')
  }, 30_000)
})
