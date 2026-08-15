import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Fetcher, fetchUsageSnapshot, formatUsageStatus, loadUsageProviders, loadUsageProvidersFromDisk,
  usageConfigPath, usageSegments,
} from '../src/usage.ts'

// ---- helper fixtures ----------------------------------------------------

function provider(kind: 'opencode' | 'deepseek', overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: kind,
    name: kind === 'opencode' ? 'opencode go' : 'DeepSeek Official',
    baseUrl: kind === 'opencode' ? 'https://opencode.ai/zen/go/v1' : 'https://api.deepseek.com/v1',
    apiKey: 'sk-test',
    kind,
    ...overrides,
  }
}

function makeConfig(providers: Record<string, unknown>): string {
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

// ---- usageConfigPath ----------------------------------------------------

describe('usageConfigPath', () => {
  it('honors DSH_REPL_ZCODE_CONFIG when set', () => {
    expect(usageConfigPath({ DSH_REPL_ZCODE_CONFIG: '/tmp/custom.json' })).toBe('/tmp/custom.json')
    expect(usageConfigPath({ DSH_REPL_ZCODE_CONFIG: '   ' })).not.toBe(' ')
  })
  it('defaults into ~/.zcode/v2 when unset', () => {
    expect(usageConfigPath({})).toMatch(/\.zcode[/\\]v2[/\\]config\.json$/)
  })
})

// ---- loadUsageProviders -------------------------------------------------

describe('loadUsageProviders', () => {
  it('returns [] for malformed JSON', () => {
    expect(loadUsageProviders('not json')).toEqual([])
    expect(loadUsageProviders('')).toEqual([])
  })
  it('returns [] when provider is not a mapping', () => {
    expect(loadUsageProviders('{"provider": null}')).toEqual([])
    expect(loadUsageProviders('{"provider": "x"}')).toEqual([])
    expect(loadUsageProviders('{"provider": [1,2]}')).toEqual([])
    expect(loadUsageProviders('{}')).toEqual([])
    expect(loadUsageProviders('42')).toEqual([])
    expect(loadUsageProviders('[1,2,3]')).toEqual([])
  })
  it('skips non-object provider entries', () => {
    expect(loadUsageProviders(makeConfig({ a: null, b: 'x', c: [1] }))).toEqual([])
  })
  it('skips a provider that omits options entirely', () => {
    expect(loadUsageProviders(makeConfig({ bare: { name: 'no options' } }))).toEqual([])
  })
  it('skips providers without an api key', () => {
    const p = provider('opencode', {})
    delete (p as { apiKey?: string }).apiKey
    p.options = { baseURL: 'https://opencode.ai/zen/go/v1' }
    expect(loadUsageProviders(makeConfig({ p }))).toEqual([])
  })
  it('classifies opencode and deepseek providers', () => {
    const oc = provider('opencode', {})
    oc.options = { baseURL: 'https://opencode.ai/zen/go/v1', apiKey: 'k' }
    const ds = provider('deepseek', {})
    ds.options = { baseURL: 'https://api.deepseek.com/v1', apiKey: 'k' }
    const out = loadUsageProviders(makeConfig({ oc, ds }))
    expect(out).toHaveLength(2)
    const opencode = out.find(o => o.kind === 'opencode')!
    expect(opencode.name).toBe('opencode go')
    expect(opencode.apiKey).toBe('k')
    const deepseek = out.find(o => o.kind === 'deepseek')!
    expect(deepseek.name).toBe('DeepSeek Official')
  })
  it('ignores providers with an unrelated base URL', () => {
    const p = { name: 'other', options: { baseURL: 'https://example.com/v1', apiKey: 'k' } }
    expect(loadUsageProviders(makeConfig({ p }))).toEqual([])
  })
  it('handles missing options and non-string base/apiKey fields, falling back to id for the name', () => {
    const p = { options: { baseURL: 'https://opencode.ai/v1', apiKey: ['not-a-string'] } }
    expect(loadUsageProviders(makeConfig({ p }))).toEqual([]) // apiKey array → not a string → skipped
    const q = { options: { baseURL: 42, apiKey: 'k' } }
    expect(loadUsageProviders(makeConfig({ q }))).toEqual([]) // baseURL number → unclassified
    const r = { options: { baseURL: 'https://opencode.ai/v1', apiKey: 'k' } }
    const out = loadUsageProviders(makeConfig({ r }))
    expect(out[0]?.name).toBe('r') // name falls back to provider id
  })
})

// ---- loadUsageProvidersFromDisk ----------------------------------------

describe('loadUsageProvidersFromDisk', () => {
  it('reads and parses a real config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-test-'))
    const p = { options: { baseURL: 'https://opencode.ai/v1', apiKey: 'k' } }
    const path = join(dir, 'config.json')
    writeFileSync(path, makeConfig({ p }))
    try {
      const out = loadUsageProvidersFromDisk(path)
      expect(out).toHaveLength(1)
      expect(out[0]?.kind).toBe('opencode')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('returns [] for a missing file', () => {
    expect(loadUsageProvidersFromDisk(join(tmpdir(), 'definitely-missing.json'))).toEqual([])
  })
})

// ---- fetchUsageSnapshot -------------------------------------------------

describe('fetchUsageSnapshot', () => {
  it('returns a bare snapshot when no matching providers exist', async () => {
    const providers = [
      { kind: 'opencode' as const, id: 'oc-go', name: 'opencode go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k' },
      { kind: 'deepseek' as const, id: 'ds-off', name: 'DeepSeek Official', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k' },
    ]
    const fetcher = stubFetch(new Map())
    const snapshot = await fetchUsageSnapshot(providers, fetcher, () => 12345)
    expect(snapshot.fetchedAt).toBe(12345)
    expect(snapshot.deepseekBalanceCny).toBeUndefined()
    expect(snapshot.opencodeName).toBeUndefined()
  })

  it('queries deepseek balance and opencode usage in parallel and aggregates results', async () => {
    const fetcher = stubFetch(new Map([
      ['https://api.deepseek.com/v1/user/balance', {
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '29.41' }, { currency: 'CNY', total_balance: 5 }],
      }],
      ['https://opencode.ai/zen/go/v1/usage', {
        usage: {
          rolling: { status: 'ok', percent: 0, resetsAt: '2026-08-14T13:59:12Z' },
          weekly: { status: 'ok', percent: 57, resetsAt: '2026-08-17T00:00:00Z' },
          monthly: { status: 'ok', percent: 31, resetsAt: '2026-09-05T11:37:11Z' },
        },
      }],
    ]))
    const providers = [
      { kind: 'deepseek' as const, id: 'ds', name: 'DeepSeek Official', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k' },
      { kind: 'opencode' as const, id: 'oc', name: 'opencode go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k' },
    ]
    const snapshot = await fetchUsageSnapshot(providers, fetcher, () => 1)
    expect(snapshot.deepseekName).toBe('DeepSeek Official')
    expect(snapshot.deepseekAvailable).toBe(true)
    expect(snapshot.deepseekBalanceCny).toBe(29.41)
    expect(snapshot.opencodeName).toBe('opencode go')
    expect(snapshot.opencode?.weekly?.percent).toBe(57)
    expect(snapshot.opencode?.rolling?.status).toBe('ok')
  })

  it('tolerates a trailing slash on the base URL', async () => {
    const fetcher = stubFetch(new Map([
      ['https://opencode.ai/zen/go/v1/user/balance', { balance_infos: [{ total_balance: 9 }] }],
    ]))
    const providers = [
      { kind: 'deepseek' as const, id: 'ds', name: 'DeepSeek', baseUrl: 'https://opencode.ai/zen/go/v1/', apiKey: 'k' },
    ]
    // baseUrl doesn't contain deepseek.com — but fetch only runs for deepseek kind; it points at the deepseek URL.
    const snapshot = await fetchUsageSnapshot(providers, fetcher, () => 2)
    expect(snapshot.deepseekBalanceCny).toBe(9)
  })

  it('records is_available=false and handles numeric balance only', async () => {
    const fetcher = stubFetch(new Map([
      ['https://api.deepseek.com/v1/user/balance', { is_available: false, balance_infos: [{ total_balance: 40 }] }],
    ]))
    const providers = [{ kind: 'deepseek' as const, id: 'ds', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k' }]
    const snapshot = await fetchUsageSnapshot(providers, fetcher, () => 3)
    expect(snapshot.deepseekAvailable).toBe(false)
    expect(snapshot.deepseekBalanceCny).toBe(40)
  })

  it('leaves the balance empty when total_balance is not finite-numeric', async () => {
    const fetcher = stubFetch(new Map([
      ['https://api.deepseek.com/v1/user/balance', { is_available: true, balance_infos: [{ total_balance: Infinity }] }],
    ]))
    const providers = [{ kind: 'deepseek' as const, id: 'ds', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k' }]
    const snapshot = await fetchUsageSnapshot(providers, fetcher, () => 3)
    expect(snapshot.deepseekBalanceCny).toBeUndefined()
  })

  it('swallows fetch failures per kind', async () => {
    const failing: Fetcher = async () => { throw new Error('boom') }
    const providers = [
      { kind: 'deepseek' as const, id: 'ds', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k' },
      { kind: 'opencode' as const, id: 'oc', name: 'opencode go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k' },
    ]
    const snapshot = await fetchUsageSnapshot(providers, failing, () => 4)
    expect(snapshot.deepseekBalanceCny).toBeUndefined()
    expect(snapshot.deepseekAvailable).toBeUndefined()
    expect(snapshot.opencodeName).toBeUndefined()
    expect(snapshot.opencode).toBeUndefined()
  })

  it('handles empty deepseek balances and zero percent opencode windows', async () => {
    const fetcher = stubFetch(new Map([
      ['https://api.deepseek.com/v1/user/balance', { is_available: true, balance_infos: [] }],
      ['https://opencode.ai/zen/go/v1/usage', { usage: { rolling: { percent: 0 }, weekly: null } }],
    ]))
    const providers = [
      { kind: 'deepseek' as const, id: 'ds', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1/', apiKey: 'k' },
      { kind: 'opencode' as const, id: 'oc', name: 'oc', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k' },
    ]
    const snapshot = await fetchUsageSnapshot(providers, fetcher, () => 5)
    expect(snapshot.deepseekBalanceCny).toBeUndefined()
    expect(snapshot.opencode?.rolling?.percent).toBe(0)
    expect(snapshot.opencode?.weekly).toBeUndefined()
  })

  it('coerces string percents and missing fields', async () => {
    const fetcher = stubFetch(new Map([
      ['https://opencode.ai/zen/go/v1/usage', { usage: { monthly: { status: 'ok', percent: '77' } } }],
    ]))
    const providers = [{ kind: 'opencode' as const, id: 'oc', name: 'oc', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k' }]
    const snapshot = await fetchUsageSnapshot(providers, fetcher, () => 6)
    expect(snapshot.opencode?.monthly?.percent).toBe(77)
    expect(snapshot.opencode?.monthly?.resetsAt).toBe('')
  })

  it('uses the default global fetch when no fetcher is injected', async () => {
    const original = globalThis.fetch
    const responses = new Map([
      ['https://api.deepseek.com/v1/user/balance', { is_available: true, balance_infos: [{ total_balance: 9 }] }],
      ['https://opencode.ai/zen/go/v1/usage', { usage: { weekly: { percent: 10 } } }],
    ])
    vi.stubGlobal('fetch', async (url: string) => {
      const hit = responses.get(url) ?? {}
      return { ok: true, status: 200, json: async () => hit }
    })
    try {
      const providers = [
        { kind: 'deepseek' as const, id: 'ds', name: 'DS', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k' },
        { kind: 'opencode' as const, id: 'oc', name: 'oc', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k' },
      ]
      const snapshot = await fetchUsageSnapshot(providers)
      expect(snapshot.deepseekBalanceCny).toBe(9)
      expect(snapshot.opencode?.weekly?.percent).toBe(10)
    } finally {
      vi.unstubAllGlobals()
      globalThis.fetch = original
    }
  })

  it('tolerates an opencode response without a usage field', async () => {
    const fetcher = stubFetch(new Map([['https://opencode.ai/zen/go/v1/usage', {}]]))
    const providers = [{ kind: 'opencode' as const, id: 'oc', name: 'oc', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k' }]
    const snapshot = await fetchUsageSnapshot(providers, fetcher, () => 9)
    expect(snapshot.opencode).toEqual({})
  })

  it('coerces weird percent values (boolean, Infinity, bad string) to 0', async () => {
    const fetcher = stubFetch(new Map([
      ['https://opencode.ai/zen/go/v1/usage', {
        usage: {
          rolling: { percent: true },
          weekly: { percent: Infinity },
          monthly: { percent: 'bad' },
        },
      }],
    ]))
    const providers = [{ kind: 'opencode' as const, id: 'oc', name: 'oc', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k' }]
    const snapshot = await fetchUsageSnapshot(providers, fetcher, () => 10)
    expect(snapshot.opencode?.rolling?.percent).toBe(0)
    expect(snapshot.opencode?.weekly?.percent).toBe(0)
    expect(snapshot.opencode?.monthly?.percent).toBe(0)
  })
})

// ---- usageSegments / formatting -----------------------------------------

describe('usageSegments', () => {
  it('returns [] when neither provider has data', () => {
    expect(usageSegments({ fetchedAt: 0 })).toEqual([])
  })

  it('builds an opencode segment showing remaining per window', () => {
    const snapshot = {
      fetchedAt: 1,
      opencodeName: 'opencode go',
      opencode: {
        rolling: { status: 'ok', percent: 1, resetsAt: '' },
        weekly: { status: 'ok', percent: 57, resetsAt: '' },
        monthly: { status: 'ok', percent: 35, resetsAt: '' },
      } as const,
    }
    // 100 − used → remaining percentages for each window.
    expect(usageSegments(snapshot)[0]?.text).toBe('OC 99% 43% 65%')
  })

  it('orders windows as rolling, weekly, monthly and treats a missing window as 0% used', () => {
    const snapshot = {
      fetchedAt: 1,
      opencode: {
        monthly: { status: 'ok', percent: 40, resetsAt: '' },
        weekly: { status: 'ok', percent: 60, resetsAt: '' },
      } as const,
    }
    const segment = usageSegments(snapshot)[0]!
    // 100 − used; the missing rolling window reads as 100% remaining.
    expect(segment.text).toBe('OC 100% 40% 60%')
    expect(segment.tone).toBe('yellow')
  })

  it('appends the nearest future reset to the opencode segment', () => {
    const snapshot = {
      fetchedAt: Date.parse('2026-08-16T00:00:00Z'),
      opencode: {
        rolling: { status: 'ok', percent: 10, resetsAt: '2026-08-16T13:59:00Z' }, // ~14h away
        weekly: { status: 'ok', percent: 57, resetsAt: '2026-08-17T00:00:00Z' }, // 24h away
      } as const,
    }
    const segment = usageSegments(snapshot)[0]!
    expect(segment.text).toBe('OC 90% 43% 100% ⇠13h')
  })

  it('omits the reset suffix when no window has a usable future resetsAt', () => {
    const snapshot = {
      fetchedAt: 1,
      opencode: {
        rolling: { status: 'ok', percent: 30, resetsAt: '' },
        weekly: { status: 'ok', percent: 60, resetsAt: 'not-a-date' },
      } as const,
    }
    expect(usageSegments(snapshot)[0]?.text).toBe('OC 70% 40% 100%')
  })

  it('shows a dash when opencode has no usable window', () => {
    const snapshot = {
      fetchedAt: 1,
      opencodeName: 'oc',
      opencode: { rolling: { status: 'ok', percent: 0, resetsAt: '' } } as const,
    }
    const segment = usageSegments(snapshot)[0]!
    expect(segment.text).toBe('OC —')
    expect(segment.tone).toBe('gray')
  })

  it('builds balance segments with correct tones', () => {
    expect(usageSegments({ fetchedAt: 1, deepseekBalanceCny: 29.41, deepseekAvailable: true })[0]).toEqual({ text: 'DS ¥29.41', tone: 'green' })
    expect(usageSegments({ fetchedAt: 1, deepseekBalanceCny: 10, deepseekAvailable: true })[0]?.tone).toBe('yellow')
    expect(usageSegments({ fetchedAt: 1, deepseekBalanceCny: 2, deepseekAvailable: true })[0]?.tone).toBe('red')
    expect(usageSegments({ fetchedAt: 1, deepseekName: 'DeepSeek Official', deepseekBalanceCny: 0, deepseekAvailable: true })[0])
      .toEqual({ text: 'DS 余额 —', tone: 'gray' })
    expect(usageSegments({ fetchedAt: 1, deepseekName: 'DS', deepseekAvailable: false })[0])
      .toEqual({ text: 'DS 余额不可用', tone: 'red' })
  })
})

describe('formatUsageStatus', () => {
  it('returns empty when nothing to show', () => {
    expect(formatUsageStatus({ fetchedAt: 0 })).toBe('')
  })
  it('renders red/gray tones and integer CNY with the default style', () => {
    const red = {
      fetchedAt: 1,
      opencode: { rolling: { status: 'ok', percent: 95, resetsAt: '' } } as const,
    }
    expect(formatUsageStatus(red)).toBe('OC 5% 100% 100%')
    const cny = {
      fetchedAt: 1,
      deepseekName: 'DS',
      deepseekAvailable: true,
      deepseekBalanceCny: 100,
    }
    expect(formatUsageStatus(cny)).toBe('DS ¥100')
  })
  it('renders a gray dash segment with the default style', () => {
    const snapshot = {
      fetchedAt: 1,
      opencode: { rolling: { status: 'ok', percent: 0, resetsAt: '' } } as const,
    }
    expect(formatUsageStatus(snapshot)).toBe('OC —')
  })
  it('joins segments with styled separators and applies tones', () => {
    const snapshot = {
      fetchedAt: 1,
      opencodeName: 'oc',
      opencode: {
        rolling: { status: 'ok', percent: 1, resetsAt: '' },
        weekly: { status: 'ok', percent: 57, resetsAt: '' },
        monthly: { status: 'ok', percent: 35, resetsAt: '' },
      } as const,
      deepseekBalanceCny: 29.41,
      deepseekAvailable: true,
    }
    const st = {
      green: (s: string) => `<g>${s}</g>`,
      yellow: (s: string) => `<y>${s}</y>`,
      red: (s: string) => `<r>${s}</r>`,
      gray: (s: string) => `<gr>${s}</gr>`,
    }
    expect(formatUsageStatus(snapshot, st)).toBe('<y>OC 99% 43% 65%</y> <gr>·</gr> <g>DS ¥29.41</g>')
  })
})
