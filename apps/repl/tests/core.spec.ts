import { describe, expect, it } from 'vitest'
import {
  createStats, fixCommand, fmtDuration, fmtTokens, formatModelTag, formatStatsLine,
  loadModelsFromConfig, pickRoute, statsOnEvent,
} from '../core.js'

// 与 interactive.cordis.yml 结构一致的配置片段（含 !!js 标签）
const CONFIG_FIXTURE = `
- id: sdk-jsonrpc-server
  name: '@deepseek-ai/dsh-sdk-jsonrpc-server'
  config:
    maxTokensAsSuccess: !!js "true"
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      opencode-go:
        api: openai-responses
        models:
          - id: deepseek-v4-flash
            name: DeepSeek V4 Flash
            contextWindow: 1000000
            maxTokens: 384000
          - id: deepseek-v4-pro
            name: DeepSeek V4 Pro
            contextWindow: 1000000
            maxTokens: 384000
      opencode-go-completions:
        api: openai-completions
        models:
          - id: deepseek-v4-flash
            name: DeepSeek V4 Flash (dup)
            contextWindow: 999999
          - id: kimi-k3
            name: Kimi K3
            contextWindow: 256000
            maxTokens: 65536
          - id: bare-model
`

describe('fmtTokens', () => {
  it('formats plain counts under 1K', () => {
    expect(fmtTokens(0)).toBe('0')
    expect(fmtTokens(517)).toBe('517')
    expect(fmtTokens(999)).toBe('999')
  })
  it('formats K with one decimal below 100', () => {
    expect(fmtTokens(1_000)).toBe('1K')
    expect(fmtTokens(12_345)).toBe('12.3K')
    expect(fmtTokens(99_999)).toBe('100K')
  })
  it('formats M', () => {
    expect(fmtTokens(1_000_000)).toBe('1M')
    expect(fmtTokens(1_234_567)).toBe('1.2M')
  })
  it('handles fractional thresholds', () => {
    expect(fmtTokens(100_500)).toBe('101K')
    expect(fmtTokens(999_999)).toBe('1000K')
  })
})

describe('fmtDuration', () => {
  it('formats sub-minute as seconds', () => {
    expect(fmtDuration(0)).toBe('0s')
    expect(fmtDuration(500)).toBe('0.5s')
    expect(fmtDuration(45_200)).toBe('45.2s')
    expect(fmtDuration(59_900)).toBe('59.9s')
  })
  it('formats minutes as m+s', () => {
    expect(fmtDuration(60_000)).toBe('1m0s')
    expect(fmtDuration(162_000)).toBe('2m42s')
    expect(fmtDuration(180_000)).toBe('3m0s')
  })
})

describe('loadModelsFromConfig', () => {
  it('merges models across routes, responses route wins on duplicate id', () => {
    const models = loadModelsFromConfig(CONFIG_FIXTURE)
    expect(models.length).toBe(4)
    // deepseek-v4-flash 在两个 route 都有 → 保留第一个（opencode-go）
    const flash = models.find(m => m.id === 'deepseek-v4-flash')
    expect(flash.provider).toBe('opencode-go')
    expect(flash.name).toBe('DeepSeek V4 Flash')
    expect(flash.contextWindow).toBe(1_000_000)
    expect(flash.maxTokens).toBe(384_000)
  })
  it('keeps route provenance and parses numbers', () => {
    const models = loadModelsFromConfig(CONFIG_FIXTURE)
    const kimi = models.find(m => m.id === 'kimi-k3')
    expect(kimi.provider).toBe('opencode-go-completions')
    expect(kimi.contextWindow).toBe(256_000)
    expect(kimi.maxTokens).toBe(65_536)
  })
  it('tolerates models missing optional fields', () => {
    const models = loadModelsFromConfig(CONFIG_FIXTURE)
    const bare = models.find(m => m.id === 'bare-model')
    expect(bare).toBeDefined()
    expect(bare.name).toBe('bare-model')
    expect(bare.contextWindow).toBeUndefined()
    expect(bare.maxTokens).toBeUndefined()
    expect(bare.provider).toBe('opencode-go-completions')
  })
  it('returns [] for empty, malformed, or non-config input', () => {
    expect(loadModelsFromConfig('')).toEqual([])
    expect(loadModelsFromConfig('not: [valid yaml')).toEqual([])
    expect(loadModelsFromConfig('- id: other\n  name: x')).toEqual([])
    expect(loadModelsFromConfig(null)).toEqual([])
    expect(loadModelsFromConfig(undefined)).toEqual([])
  })
  it('handles providers without models or invalid entries', () => {
    expect(loadModelsFromConfig('- id: llm-pi-ai\n  config:\n    providers:\n      a:\n        models: []')).toEqual([])
    expect(loadModelsFromConfig('- id: llm-pi-ai\n  config:\n    providers:\n      a:\n        models:\n          - {}')).toEqual([])
  })
})

describe('pickRoute', () => {
  const models = loadModelsFromConfig(CONFIG_FIXTURE)
  it('resolves the declaring route', () => {
    expect(pickRoute('kimi-k3', models, 'fallback')).toBe('opencode-go-completions')
    expect(pickRoute('deepseek-v4-pro', models, 'fallback')).toBe('opencode-go')
  })
  it('falls back for unknown ids and empty lists', () => {
    expect(pickRoute('nope', models, 'fallback')).toBe('fallback')
    expect(pickRoute('deepseek-v4-flash', [], 'fallback')).toBe('fallback')
    expect(pickRoute('deepseek-v4-flash', undefined, 'fallback')).toBe('fallback')
  })
})

describe('statsOnEvent', () => {
  it('accumulates a full turn lifecycle', () => {
    const stats = createStats('opencode-go', 'deepseek-v4-flash')
    const t = 10_000 // 起始时间

    expect(statsOnEvent(stats, { type: 'turn/start', time: t + 0, data: {} })).toBe(true)
    expect(statsOnEvent(stats, { type: 'step/start', time: t + 100, data: {} })).toBe(true)

    // 首个 chunk 计 TTFT（step/start → chunk）
    expect(statsOnEvent(stats, { type: 'assistant/chunk', time: t + 3_000, data: { chunk: { type: 'reasoning-delta', text: 'think' } } })).toBe(true)
    // 后续 chunk 不再计 TTFT
    expect(statsOnEvent(stats, { type: 'assistant/chunk', time: t + 3_100, data: { chunk: { type: 'text-delta', text: 'hi' } } })).toBe(false)

    // assistant/message：LLM 耗时（step→message）+ decode（首 chunk→message）+ usage
    const changed = statsOnEvent(stats, {
      type: 'assistant/message', time: t + 8_000,
      data: { message: { content: [] }, usage: { inputTokens: 1000, cacheReadTokens: 500, cacheWriteTokens: 100, outputTokens: 64 } },
    })
    expect(changed).toBe(true)
    expect(stats.turns).toBe(1)
    expect(stats.steps).toBe(1)
    expect(stats.ttftMs).toBe(2_900)
    expect(stats.ttftSteps).toBe(1)
    expect(stats.llmMs).toBe(7_900) // 100 → 8000
    expect(stats.decodeMs).toBe(5_000) // 3000 → 8000
    expect(stats.billedInput).toBe(1_600) // 1000+500+100
    expect(stats.outputTokens).toBe(64)
    expect(stats.cacheRead).toBe(500)
    expect(stats.lastBilledInput).toBe(1_600)
    expect(stats.decodeTokens).toBe(64)
  })

  it('tracks request/context model and window', () => {
    const stats = createStats('opencode-go', 'deepseek-v4-flash')
    expect(statsOnEvent(stats, {
      type: 'request/context', time: 1, data: { provider: 'opencode-go-completions', model: 'kimi-k3', contextWindow: 256000 },
    })).toBe(true)
    expect(stats.providerName).toBe('opencode-go-completions')
    expect(stats.modelName).toBe('kimi-k3')
    expect(stats.contextWindow).toBe(256_000)
  })

  it('tracks tool wall time', () => {
    const stats = createStats()
    expect(statsOnEvent(stats, { type: 'tool/call', time: 100, data: { name: 'bash', arguments: '{}' } })).toBe(true)
    expect(statsOnEvent(stats, { type: 'tool/result', time: 1_300, data: { message: { content: [] } } })).toBe(true)
    expect(stats.toolMs).toBe(1_200)
    // 连续第二次 result（无 call）不产生变化
    expect(statsOnEvent(stats, { type: 'tool/result', time: 2_000, data: {} })).toBe(false)
  })

  it('ignores unknown events', () => {
    const stats = createStats()
    expect(statsOnEvent(stats, { type: 'agent/inbox/spliced', time: 1, data: {} })).toBe(false)
    expect(stats.turns).toBe(0)
  })

  it('handles missing usage gracefully', () => {
    const stats = createStats()
    statsOnEvent(stats, { type: 'turn/start', time: 1, data: {} })
    statsOnEvent(stats, { type: 'step/start', time: 2, data: {} })
    // 无 usage 的 assistant/message：只累计 LLM 耗时
    expect(statsOnEvent(stats, { type: 'assistant/message', time: 5_002, data: { message: { content: [] } } })).toBe(true)
    expect(stats.llmMs).toBe(5_000)
    expect(stats.billedInput).toBe(0)
    // 无 stepStart 的 assistant/message：不累计（异常流）
    const s2 = createStats()
    expect(statsOnEvent(s2, { type: 'assistant/message', time: 1, data: { usage: { inputTokens: 5, outputTokens: 5 } } })).toBe(true)
    expect(s2.llmMs).toBe(0)
    expect(s2.billedInput).toBe(5)
  })
})

describe('formatStatsLine', () => {
  const NO_STYLE = { gray: s => s, cyan: s => s, green: s => s, yellow: s => s }

  it('returns empty string before any step', () => {
    expect(formatStatsLine(createStats('p', 'm'))).toBe('')
  })

  it('renders counts, durations, speeds, cache, tokens and ctx', () => {
    const stats = createStats('opencode-go', 'deepseek-v4-flash')
    stats.turns = 2; stats.steps = 3
    stats.llmMs = 336_000; stats.toolMs = 177_000
    stats.ttftMs = 3_200; stats.ttftSteps = 1
    stats.decodeMs = 4_000; stats.decodeTokens = 448
    stats.billedInput = 3_600_000; stats.outputTokens = 2_100; stats.cacheRead = 3_456_000
    stats.contextWindow = 1_000_000; stats.lastBilledInput = 100_000
    const line = formatStatsLine(stats, NO_STYLE)
    expect(line).toContain('2 轮 · 3 步')
    expect(line).toContain('LLM 5m36s')
    expect(line).toContain('工具调用 2m57s')
    expect(line).toContain('首 token 平均 3.2s')
    expect(line).toContain('112 tok/s')
    expect(line).toContain('缓存命中 96%')
    expect(line).toContain('输入 3.6M tokens · 输出 2.1K tokens')
    expect(line).toContain('ctx 10%')
  })

  it('omits durations/speeds without data', () => {
    const stats = createStats('p', 'm')
    stats.turns = 1; stats.steps = 1
    const line = formatStatsLine(stats, NO_STYLE)
    expect(line).toBe('1 轮 · 1 步')
  })

  it('omits cache group when no cache read', () => {
    const stats = createStats('p', 'm')
    stats.turns = 1; stats.steps = 1; stats.billedInput = 100; stats.outputTokens = 10
    const line = formatStatsLine(stats, NO_STYLE)
    expect(line).not.toContain('缓存命中')
    expect(line).toContain('输入 100 tokens · 输出 10 tokens')
  })

  it('clamps ctx percent to 100', () => {
    const stats = createStats('p', 'm')
    stats.turns = 1; stats.steps = 1
    stats.billedInput = 100; stats.outputTokens = 0
    stats.contextWindow = 10; stats.lastBilledInput = 50
    expect(formatStatsLine(stats, NO_STYLE)).toContain('ctx 100%')
  })

  it('applies injected styles', () => {
    const stats = createStats('p', 'm')
    stats.turns = 1; stats.steps = 1
    const st = { gray: s => `[${s}]`, cyan: s => `<${s}>`, green: s => `!${s}!`, yellow: s => `?${s}?` }
    const line = formatStatsLine(stats, st)
    expect(line).toContain('[轮]')
    expect(line).toContain('[步]')
  })
})

describe('formatModelTag', () => {
  it('joins provider and model', () => {
    expect(formatModelTag('opencode-go', 'deepseek-v4-flash')).toBe('opencode-go · deepseek-v4-flash')
  })
})

describe('fixCommand', () => {
  const CMDS = ['compact', 'feedback', 'goal', 'export', 'model', 'models', 'new', 'exit', 'quit']
  it('leaves clean commands untouched', () => {
    expect(fixCommand('/compact', CMDS)).toBe('/compact')
    expect(fixCommand('/model kimi-k3', CMDS)).toBe('/model kimi-k3')
    expect(fixCommand('/goal set 目标', CMDS)).toBe('/goal set 目标')
  })
  it('fixes duplicated command names from autocomplete', () => {
    expect(fixCommand('/compcompact', CMDS)).toBe('/compact')
    expect(fixCommand('/comcompact', CMDS)).toBe('/compact')
    expect(fixCommand('/newnew', CMDS)).toBe('/new')
    expect(fixCommand('/modelmodel x', CMDS)).toBe('/model x')
  })
  it('prefers the longest matching command', () => {
    expect(fixCommand('/modelsmodels', CMDS)).toBe('/models')
  })
  it('leaves non-command text and unknown commands untouched', () => {
    expect(fixCommand('hello world', CMDS)).toBe('hello world')
    expect(fixCommand('/whatever', CMDS)).toBe('/whatever')
    expect(fixCommand('', CMDS)).toBe('')
  })
})
