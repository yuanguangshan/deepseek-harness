import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { projectHash, todayStamp } from '@deepseek-ai/dsh-memory'
import { type Fetcher } from '@deepseek-ai/dsh-usage'

import * as tool from '../src/index.ts'

// ---- helper fixtures ----------------------------------------------------

function provider(kind: 'opencode' | 'deepseek'): Record<string, unknown> {
  return {
    name: kind === 'opencode' ? 'opencode go' : 'DeepSeek Official',
    options: {
      baseURL: kind === 'opencode' ? 'https://opencode.ai/zen/go/v1' : 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
    },
  }
}

function zcodeConfigText(providers: Record<string, unknown>): string {
  return JSON.stringify({ provider: providers })
}

function stubFetch(bodyByUrl: Map<string, unknown>): Fetcher {
  return async url => ({
    ok: true,
    status: 200,
    json: async () => {
      const urlNorm = url.endsWith('/') ? url.slice(0, -1) : url
      const hit = bodyByUrl.get(urlNorm)
      if (hit === undefined) throw new Error(`unexpected url: ${url}`)
      return hit
    },
  })
}

let root: string | undefined
let zcodePath: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-tool-companion-'))
  zcodePath = join(root, 'zcode-config.json')
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function cfg(): tool.Config {
  return {
    ...(root !== undefined ? { memoryDir: root } : {}),
    ...(zcodePath !== undefined ? { zcodeConfigPath: zcodePath } : {}),
  }
}

// ---- runMemoryOp ---------------------------------------------------------

describe('runMemoryOp', () => {
  it('adds a memory-track entry without a cwd', () => {
    expect(tool.runMemoryOp(cfg(), { op: 'add', target: 'memory', content: 'the deploy runs on port 8080' }, '/workspace')).toBe(
      'Recorded to memory track.',
    )
    expect(readFileSync(join(root!, 'MEMORY.md'), 'utf8')).toContain('the deploy runs on port 8080')
  })

  it('rejects add with a blank content', () => {
    expect(() => tool.runMemoryOp(cfg(), { op: 'add', target: 'memory', content: '   ' }, '/workspace')).toThrow(
      'memory add requires a non-empty `content`',
    )
    expect(() => tool.runMemoryOp(cfg(), { op: 'add', target: 'memory' }, '/workspace')).toThrow(
      'memory add requires a non-empty `content`',
    )
  })

  it('falls back to the default memory dir when unconfigured', () => {
    const previous = process.env.DSH_REPL_MEMORY_DIR
    process.env.DSH_REPL_MEMORY_DIR = root!
    try {
      expect(tool.runMemoryOp({}, { op: 'entries', target: 'memory' }, '/workspace')).toBe('No entries in memory track.')
    } finally {
      if (previous === undefined) delete process.env.DSH_REPL_MEMORY_DIR
      else process.env.DSH_REPL_MEMORY_DIR = previous
    }
  })

  it('adds a project-track entry using the supplied cwd', () => {
    tool.runMemoryOp(cfg(), { op: 'add', target: 'project', content: 'harness builds via pnpm' }, '/workspaces/harness')
    const text = readFileSync(join(root!, 'projects', projectHash('/workspaces/harness'), 'MEMORY.md'), 'utf8')
    expect(text).toContain('harness builds via pnpm')
  })

  it('reports empty entries', () => {
    expect(tool.runMemoryOp(cfg(), { op: 'entries', target: 'memory' }, '/workspace')).toBe('No entries in memory track.')
  })

  it('lists entries numbered when present', () => {
    tool.runMemoryOp(cfg(), { op: 'add', target: 'memory', content: 'first' }, '/workspace')
    tool.runMemoryOp(cfg(), { op: 'add', target: 'memory', content: 'second' }, '/workspace')
    expect(tool.runMemoryOp(cfg(), { op: 'entries', target: 'memory' }, '/workspace')).toBe(
      `1. [${todayStamp()}] first\n2. [${todayStamp()}] second`,
    )
  })

  it('rejects remove with a blank needle', () => {
    expect(() => tool.runMemoryOp(cfg(), { op: 'remove', target: 'memory', needle: '' }, '/workspace')).toThrow(
      'memory remove requires a non-empty `needle`',
    )
    expect(() => tool.runMemoryOp(cfg(), { op: 'remove', target: 'memory' }, '/workspace')).toThrow(
      'memory remove requires a non-empty `needle`',
    )
  })

  it('removes matching entries and reports the count', () => {
    tool.runMemoryOp(cfg(), { op: 'add', target: 'memory', content: 'alpha' }, '/workspace')
    tool.runMemoryOp(cfg(), { op: 'add', target: 'memory', content: 'beta' }, '/workspace')
    expect(tool.runMemoryOp(cfg(), { op: 'remove', target: 'memory', needle: 'a' }, '/workspace')).toBe(
      'Removed 2 entries from memory track.',
    )
    expect(tool.runMemoryOp(cfg(), { op: 'entries', target: 'memory' }, '/workspace')).toBe('No entries in memory track.')
  })

  it('reports a single removal with singular wording', () => {
    tool.runMemoryOp(cfg(), { op: 'add', target: 'memory', content: 'alpha' }, '/workspace')
    expect(tool.runMemoryOp(cfg(), { op: 'remove', target: 'memory', needle: 'alpha' }, '/workspace')).toBe(
      'Removed 1 entry from memory track.',
    )
  })

  it('reports no matches without changing the track', () => {
    tool.runMemoryOp(cfg(), { op: 'add', target: 'memory', content: 'alpha' }, '/workspace')
    expect(tool.runMemoryOp(cfg(), { op: 'remove', target: 'memory', needle: 'zzz' }, '/workspace')).toBe(
      'No matching entries in memory track.',
    )
  })

  it('clears a whole track', () => {
    tool.runMemoryOp(cfg(), { op: 'add', target: 'memory', content: 'alpha' }, '/workspace')
    expect(tool.runMemoryOp(cfg(), { op: 'clear', target: 'memory' }, '/workspace')).toBe('Cleared memory track.')
    expect(readFileSync(join(root!, 'MEMORY.md'), 'utf8')).toBe('')
  })
})

// ---- runUsageStatus ------------------------------------------------------

describe('runUsageStatus', () => {
  it('reports no providers when the config has none', async () => {
    writeFileSync(zcodePath!, zcodeConfigText({}), 'utf8')
    await expect(tool.runUsageStatus(cfg())).resolves.toBe(
      'No quota providers found (no opencode.ai or deepseek.com provider in the ZCode config).',
    )
  })

  it('falls back to the default config path when unconfigured', async () => {
    writeFileSync(zcodePath!, zcodeConfigText({}), 'utf8')
    const previous = process.env.DSH_REPL_ZCODE_CONFIG
    process.env.DSH_REPL_ZCODE_CONFIG = zcodePath!
    try {
      await expect(tool.runUsageStatus({ memoryDir: root! })).resolves.toBe(
        'No quota providers found (no opencode.ai or deepseek.com provider in the ZCode config).',
      )
    } finally {
      if (previous === undefined) delete process.env.DSH_REPL_ZCODE_CONFIG
      else process.env.DSH_REPL_ZCODE_CONFIG = previous
    }
  })

  it('renders a status line from stubbed quota responses', async () => {
    writeFileSync(zcodePath!, zcodeConfigText({ opencode: provider('opencode'), deepseek: provider('deepseek') }), 'utf8')
    vi.stubGlobal('fetch', stubFetch(new Map([
      ['https://api.deepseek.com/v1/user/balance', {
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '29.41' }],
      }],
      ['https://opencode.ai/zen/go/v1/usage', {
        usage: {
          rolling: { status: 'ok', percent: 0, resetsAt: '2026-08-14T13:59:12Z' },
          weekly: { status: 'ok', percent: 57, resetsAt: '2026-08-17T00:00:00Z' },
          monthly: { status: 'ok', percent: 31, resetsAt: '2026-09-05T11:37:11Z' },
        },
      }],
    ])))
    const line = await tool.runUsageStatus(cfg())
    expect(line).toContain('OC')
    expect(line).toContain('DS')
  })

  it('reports unavailable data when every query fails', async () => {
    writeFileSync(zcodePath!, zcodeConfigText({ opencode: provider('opencode'), deepseek: provider('deepseek') }), 'utf8')
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down')
    })
    await expect(tool.runUsageStatus(cfg())).resolves.toBe('Quota data unavailable (queries failed or returned nothing).')
  })
})

// ---- tool registration through a real ToolRuntime -------------------------

async function setup(config: tool.Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool, config)
  return ctx
}

function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`companion-${name}-${Math.random().toString(36).slice(2)}`),
    name,
    arguments: args,
  })
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('registered tools', () => {
  it('registers memory and usage_status with model-facing descriptions', async () => {
    const ctx = await setup(cfg())
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('memory')
    expect(names).toContain('usage_status')
    const memory = ctx.tools.schemas().find(s => s.name === 'memory')!
    expect(memory.description).toContain('Record, read, remove, or clear cross-session memory')
    const usage = ctx.tools.schemas().find(s => s.name === 'usage_status')!
    expect(usage.description).toContain('Check current API usage and quota')
  })

  it('executes memory add and entries end to end', async () => {
    const ctx = await setup(cfg())
    const added = await call(ctx, 'memory', { op: 'add', target: 'memory', content: 'remember me' })
    expect(textOf(added)).toBe('Recorded to memory track.')
    const entries = await call(ctx, 'memory', { op: 'entries', target: 'memory' })
    expect(textOf(entries)).toContain('remember me')
  })

  it('presents the memory call with a stable title', async () => {
    const ctx = await setup(cfg())
    const def = ctx.tools.get('memory')!
    expect(def.presentCall?.({ op: 'add', target: 'key' })).toEqual({
      card: 'generic',
      title: 'Memory',
      kind: 'other',
      rawInput: 'add key',
    })
  })

  it('presents the usage_status call with a stable title', async () => {
    const ctx = await setup(cfg())
    const def = ctx.tools.get('usage_status')!
    expect(def.presentCall?.({})).toEqual({ card: 'generic', title: 'Usage status', kind: 'other', rawInput: '' })
  })

  it('unregisters both tools when the contributing fiber is disposed (HMR-safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(tool, cfg())
    expect(ctx.tools.schemas().some(s => s.name === 'memory')).toBe(true)
    expect(ctx.tools.schemas().some(s => s.name === 'usage_status')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'memory')).toBe(false)
    expect(ctx.tools.schemas().some(s => s.name === 'usage_status')).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-companion')
    expect(tool.inject).toEqual(['tools'])
  })
})
