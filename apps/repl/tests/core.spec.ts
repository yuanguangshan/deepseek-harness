import { describe, expect, it } from 'vitest'
import {
  bracketScrollAction, collapseToolText, COLLAPSE_HEAD_LINES, COLLAPSE_TAIL_LINES, briefToolArgs, createStats, describeToolArgs,
  fixCommand, fmtDuration, fmtTokens, formatModelTag, formatPctBar, formatStatsFields, formatStatsLine, formatTurnBanter, interactiveConfig,
  isAbnormalTurnEnd, livePhaseText, loadModelsFromConfig, nextToolCardVisibility, packStatFields, pickRoute,
  REASONING_PREVIEW_MAX, repoRoot, runtimeBin,
  statsOnEvent, stepSlideWindow, summarizeToolResult, shouldFlushStream, STREAM_FLUSH_MS, TOOL_CARD_CYCLE,
} from '../src/core.ts'

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
  it('keeps the same model id on different routes as distinct choices', () => {
    const models = loadModelsFromConfig(CONFIG_FIXTURE)
    expect(models.length).toBe(5)
    // 同一 id 出现在两个 route（协议不同）→ 各自保留，按 provider:model 去重
    const flash = models.filter(m => m.id === 'deepseek-v4-flash')
    expect(flash.map(m => m.provider)).toEqual(['opencode-go', 'opencode-go-completions'])
    expect(flash[0]!.name).toBe('DeepSeek V4 Flash')
    expect(flash[0]!.contextWindow).toBe(1_000_000)
    expect(flash[0]!.maxTokens).toBe(384_000)
  })
  it('keeps route provenance and parses numbers', () => {
    const models = loadModelsFromConfig(CONFIG_FIXTURE)
    const kimi = models.find(m => m.id === 'kimi-k3')!
    expect(kimi.provider).toBe('opencode-go-completions')
    expect(kimi.contextWindow).toBe(256_000)
    expect(kimi.maxTokens).toBe(65_536)
  })
  it('tolerates models missing optional fields', () => {
    const models = loadModelsFromConfig(CONFIG_FIXTURE)
    const bare = models.find(m => m.id === 'bare-model')!
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
    expect(loadModelsFromConfig(null as unknown as string)).toEqual([])
    expect(loadModelsFromConfig(undefined as unknown as string)).toEqual([])
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
    expect(stats.livePhase).toBe('thinking')
    expect(statsOnEvent(stats, { type: 'step/start', time: t + 100, data: {} })).toBe(true)
    expect(stats.livePhase).toBe('thinking')

    // 推理流：保持 thinking，累积思考预览，不计 TTFT
    expect(statsOnEvent(stats, { type: 'assistant/chunk', time: t + 3_000, data: { chunk: { type: 'reasoning-delta', text: 'think' } } })).toBe(true)
    expect(stats.livePhase).toBe('thinking') // 推理阶段仍是思考中
    expect(stats.reasoningPreview).toBe('think')
    // 首个文本 token 计 TTFT（step/start → 首个文本 chunk）
    expect(statsOnEvent(stats, { type: 'assistant/chunk', time: t + 3_100, data: { chunk: { type: 'text-delta', text: 'hi' } } })).toBe(true)
    expect(stats.livePhase).toBe('responding') // 进入作答
    // 后续文本 chunk 不再计 TTFT
    expect(statsOnEvent(stats, { type: 'assistant/chunk', time: t + 3_200, data: { chunk: { type: 'text-delta', text: ' again' } } })).toBe(false)

    // assistant/message：LLM 耗时（step→message）+ decode（首文本 chunk→message）+ usage
    const changed = statsOnEvent(stats, {
      type: 'assistant/message', time: t + 8_000,
      data: { message: { content: [] }, usage: { inputTokens: 1000, cacheReadTokens: 500, cacheWriteTokens: 100, outputTokens: 64 } },
    })
    expect(changed).toBe(true)
    expect(stats.turns).toBe(1)
    expect(stats.steps).toBe(1)
    expect(stats.ttftMs).toBe(3_000)
    expect(stats.ttftSteps).toBe(1)
    expect(stats.llmMs).toBe(7_900) // 10100 → 18000
    expect(stats.decodeMs).toBe(4_900) // 13100 → 18000
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
    expect(stats.livePhase).toBe('tools')
    expect(statsOnEvent(stats, { type: 'tool/result', time: 1_300, data: { message: { content: [] } } })).toBe(true)
    expect(stats.toolMs).toBe(1_200)
    expect(stats.livePhase).toBe('thinking') // 工具返回后模型继续作答
    // 连续第二次 result（无 call）不产生变化
    expect(statsOnEvent(stats, { type: 'tool/result', time: 2_000, data: {} })).toBe(false)
  })

  it('resets live phase to idle on turn/end', () => {
    const stats = createStats()
    statsOnEvent(stats, { type: 'turn/start', time: 1, data: {} })
    expect(stats.livePhase).toBe('thinking')
    expect(statsOnEvent(stats, { type: 'turn/end', time: 2, data: {} })).toBe(true)
    expect(stats.livePhase).toBe('idle')
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
  const NO_STYLE = { gray: (s: string) => s, cyan: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s }

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
    expect(line).toContain('tools 2m57s')
    expect(line).toContain('首token 3.2s')
    expect(line).toContain('112 tok/s')
    expect(line).toContain('缓存 96%')
    expect(line).toContain('↑ 3.6M · ↓ 2.1K')
    expect(line).toContain('ctx')
    expect(line).toContain('10%')
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
    expect(line).toContain('↑ 100 · ↓ 10')
  })

  it('clamps ctx percent to 100', () => {
    const stats = createStats('p', 'm')
    stats.turns = 1; stats.steps = 1
    stats.billedInput = 100; stats.outputTokens = 0
    stats.contextWindow = 10; stats.lastBilledInput = 50
    expect(formatStatsLine(stats, NO_STYLE)).toContain('100%')
  })

  it('applies injected styles', () => {
    const stats = createStats('p', 'm')
    stats.turns = 1; stats.steps = 1
    const st = { gray: (s: string) => `[${s}]`, cyan: (s: string) => `<${s}>`, green: (s: string) => `!${s}!`, yellow: (s: string) => `?${s}?` }
    const line = formatStatsLine(stats, st)
    expect(line).toContain('[轮]')
    expect(line).toContain('[步]')
  })

  it('shows a session-duration field once a step has run', () => {
    const stats = createStats('p', 'm')
    stats.sessionStart = 1_000_000
    stats.turns = 1; stats.steps = 1
    expect(formatStatsFields(stats, NO_STYLE, 1_000_000)).toEqual(['1 轮 · 1 步'])
    expect(formatStatsFields(stats, NO_STYLE, 1_165_000)).toEqual(['会话 2m45s', '1 轮 · 1 步'])
  })
})

describe('formatPctBar', () => {
  it('renders a clamped ▓/░ bar of the given width', () => {
    expect(formatPctBar(0, 4)).toBe('░░░░')
    expect(formatPctBar(10, 4)).toBe('░░░░') // 0.1*4=0.4 → 0 filled
    expect(formatPctBar(50, 4)).toBe('▓▓░░')
    expect(formatPctBar(100, 4)).toBe('▓▓▓▓')
    expect(formatPctBar(200, 4)).toBe('▓▓▓▓') // clamped to 100
    expect(formatPctBar(-5, 4)).toBe('░░░░') // clamped to 0
  })
})

describe('packStatFields', () => {
  it('returns [] for empty fields', () => {
    expect(packStatFields([], ' | ', 80)).toEqual([])
  })
  it('keeps one short field on one line', () => {
    expect(packStatFields(['a'], ' | ', 80)).toEqual(['a'])
  })
  it('wraps fields that exceed a narrow budget onto separate lines', () => {
    // "a | b | c" is 9 wide; a 5-column budget pushes "c" to its own line.
    const lines = packStatFields(['a', 'b', 'c'], ' | ', 5)
    expect(lines).toEqual(['a | b', 'c'])
  })
  it('pushes every field to its own line when even two do not fit', () => {
    // "aa | bb" = 6 > a 5-column budget, so each field lands on its own line.
    expect(packStatFields(['aa', 'bb', 'cc'], ' | ', 5)).toEqual(['aa', 'bb', 'cc'])
  })
  it('ignores the width budget for a giant maxWidth (one line)', () => {
    const fields = ['a', 'b', 'c']
    expect(packStatFields(fields, ' | ', 0)).toEqual(['a | b | c'])
  })
})

describe('livePhaseText', () => {
  it('returns undefined while idle', () => {
    expect(livePhaseText(createStats('p', 'm'), 1_000)).toBeUndefined()
  })
  it('renders thinking + elapsed from stepStart', () => {
    const stats = createStats('p', 'm')
    statsOnEvent(stats, { type: 'turn/start', time: 100, data: {} })
    statsOnEvent(stats, { type: 'step/start', time: 100, data: {} })
    expect(livePhaseText(stats, 3_100)).toBe('思考中 3s')
  })
  it('keeps the thinking label minimal unless DSH_TUI_SHOW_THINKING_PREVIEW=1', () => {
    const stats = createStats('p', 'm')
    statsOnEvent(stats, { type: 'turn/start', time: 100, data: {} })
    statsOnEvent(stats, { type: 'step/start', time: 100, data: {} })
    statsOnEvent(stats, { type: 'assistant/chunk', time: 150, data: { chunk: { type: 'reasoning-delta', text: '权衡两难' } } })
    expect(stats.livePhase).toBe('thinking')
    // Default: the status bar never leaks the streamed reasoning text.
    expect(livePhaseText(stats, 200)).toBe('思考中 0.1s')
    process.env.DSH_TUI_SHOW_THINKING_PREVIEW = '1'
    try {
      expect(livePhaseText(stats, 200)).toBe('思考：权衡两难 0.1s')
    } finally {
      delete process.env.DSH_TUI_SHOW_THINKING_PREVIEW
    }
    // Reasoning preview is capped to REASONING_PREVIEW_MAX chars.
    statsOnEvent(stats, { type: 'assistant/chunk', time: 160, data: { chunk: { type: 'reasoning-delta', text: 'x'.repeat(60) } } })
    expect(stats.reasoningPreview.length).toBeLessThanOrEqual(REASONING_PREVIEW_MAX)
  })
  it('renders responding + elapsed from decodeStart', () => {
    const stats = createStats('p', 'm')
    statsOnEvent(stats, { type: 'turn/start', time: 100, data: {} })
    statsOnEvent(stats, { type: 'step/start', time: 100, data: {} })
    statsOnEvent(stats, { type: 'assistant/chunk', time: 200, data: { chunk: { type: 'text-delta', text: 'hi' } } })
    const text = livePhaseText(stats, 1_200)
    expect(text).toContain('作答中')
    expect(text).toContain('1s')
  })
  it('renders the executing tool name + elapsed from toolStart', () => {
    const stats = createStats('p', 'm')
    statsOnEvent(stats, { type: 'tool/call', time: 100, data: { name: 'bash', arguments: '{}' } })
    expect(livePhaseText(stats, 500)).toBe('⚙ bash 0.4s')
  })
  it('includes a brief args preview next to the tool name', () => {
    const stats = createStats('p', 'm')
    statsOnEvent(stats, {
      type: 'tool/call', time: 100,
      data: { name: 'bash', arguments: '{"command":"ls -la"}' },
    })
    expect(livePhaseText(stats, 500)).toBe('⚙ bash ls -la 0.4s')
  })
  it('falls back to the generic tools tag when no tool name is available', () => {
    const stats = createStats('p', 'm')
    stats.toolStart = 100
    stats.livePhase = 'tools'
    expect(livePhaseText(stats, 500)).toBe('工具调用中 0.4s')
  })
  it('clears the tool name when the tool returns', () => {
    const stats = createStats('p', 'm')
    statsOnEvent(stats, { type: 'tool/call', time: 100, data: { name: 'bash', arguments: '{}' } })
    expect(stats.currentToolName).toBe('bash')
    statsOnEvent(stats, { type: 'tool/result', time: 400, data: {} })
    expect(stats.currentToolName).toBe('')
  })
  it('applies the injected style', () => {
    const stats = createStats('p', 'm')
    statsOnEvent(stats, { type: 'tool/call', time: 0, data: { name: 'bash', arguments: '{}' } })
    const st = { gray: (s: string) => s, cyan: (s: string) => s, green: (s: string) => s, yellow: (s: string) => `?${s}?` }
    expect(livePhaseText(stats, 0, st)).toContain('?⚙ bash?')
  })
})

describe('formatModelTag', () => {
  it('joins provider and model', () => {
    expect(formatModelTag('opencode-go', 'deepseek-v4-flash')).toBe('opencode-go · deepseek-v4-flash')
  })
})

describe('formatTurnBanter', () => {
  it('handles an empty turn', () => {
    expect(formatTurnBanter({ steps: 0, llmMs: 0, toolMs: 0, outputTokens: 0 })).toContain('省')
    expect(formatTurnBanter({ steps: 0, llmMs: 0, toolMs: 0, outputTokens: 5 })).toContain('满分答案')
  })
  it('reports the per-turn score with a mood quip', () => {
    const out = formatTurnBanter({ steps: 4, llmMs: 12_000, toolMs: 3_000, outputTokens: 200 })
    expect(out).toContain('4 步')
    expect(out).toContain('LLM 12s')
    expect(out).toContain('tools 3s')
  })
  it('comments when tool time dominates over thinking', () => {
    expect(formatTurnBanter({ steps: 5, llmMs: 2_000, toolMs: 8_000, outputTokens: 90 })).toContain('工具搬得')
  })
  it('praises long, heavy thinking', () => {
    expect(formatTurnBanter({ steps: 2, llmMs: 60_000, toolMs: 1_000, outputTokens: 300 })).toContain('思考得够久')
  })
  it('celebrates a brisk many-step turn', () => {
    expect(formatTurnBanter({ steps: 9, llmMs: 10_000, toolMs: 4_000, outputTokens: 100 })).toContain('干活利索')
  })
})

describe('stepSlideWindow', () => {
  /** A window that shows `fits` fields; it reaches the last field once fewer than
   *  `fits` fields remain between `start` and the end. */
  const winOf = (n: number, fits: number) => (start: number): boolean => n - start <= fits

  it('stays at the leading fields facing forward when everything fits', () => {
    // 4 fields and 4+ fits → start 0 already shows the last field.
    expect(stepSlideWindow(2, -1, 4, winOf(4, 4))).toEqual({ start: 0, dir: 1 })
  })
  it('does nothing for an empty or single-field window', () => {
    expect(stepSlideWindow(0, 1, 0, () => false)).toEqual({ start: 0, dir: 1 })
    expect(stepSlideWindow(0, -1, 1, () => true)).toEqual({ start: 0, dir: -1 })
  })
  it('slides forward toward later fields', () => {
    expect(stepSlideWindow(0, 1, 6, winOf(6, 3))).toEqual({ start: 1, dir: 1 })
    expect(stepSlideWindow(1, 1, 6, winOf(6, 3))).toEqual({ start: 2, dir: 1 })
  })
  it('reverses once the right-most field is already visible, keeping the window full', () => {
    // 6 fields, window fits 3 → at start 3 the last field is visible; bounce back.
    const fits3 = winOf(6, 3)
    expect(stepSlideWindow(2, 1, 6, fits3)).toEqual({ start: 3, dir: 1 })
    // The next tick is where the reversal happens.
    expect(stepSlideWindow(3, 1, 6, fits3)).toEqual({ start: 2, dir: -1 })
  })
  it('bounces off the leading edge back toward later fields', () => {
    const fits3 = winOf(6, 3)
    expect(stepSlideWindow(0, -1, 6, fits3)).toEqual({ start: 1, dir: 1 })
  })
  it('keeps bouncing between the edges across a full cycle', () => {
    const fits3 = winOf(6, 3)
    // Sequence of next-states: 0→1→2→3, then reverses 3→2→1→0, then forward again.
    const cycle = [
      { start: 1, dir: 1 },
      { start: 2, dir: 1 },
      { start: 3, dir: 1 },
      { start: 2, dir: -1 },
      { start: 1, dir: -1 },
      { start: 0, dir: -1 },
      { start: 1, dir: 1 },
      { start: 2, dir: 1 },
    ] as const
    let state: { start: number; dir: 1 | -1 } = { start: 0, dir: 1 }
    for (const step of cycle) {
      const next = stepSlideWindow(state.start, state.dir, 6, fits3)
      expect(next.start).toBe(step.start)
      expect(next.dir).toBe(step.dir)
      state = next
    }
  })
  it('never overshoots past the last field, even when fields are wider than the window', () => {
    // One field per window slot — the last index is 3 and it must never be exceeded.
    const one = winOf(4, 1)
    expect(stepSlideWindow(2, 1, 4, one)).toEqual({ start: 3, dir: 1 })
    expect(stepSlideWindow(3, 1, 4, one)).toEqual({ start: 2, dir: -1 })
    expect(stepSlideWindow(0, -1, 4, one)).toEqual({ start: 1, dir: 1 })
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

describe('repootPath derivation', () => {
  it('points at the repository root containing packages/', () => {
    const root = repoRoot()
    expect(root.length).toBeGreaterThan(0)
  })
  it('resolves the runtime bin under packages/examples/jsonrpc-demo', () => {
    expect(runtimeBin()).toMatch(/packages[/\\]examples[/\\]jsonrpc-demo[/\\]lib[/\\]bin\.js$/)
  })
  it('honors DSH_REPL_RUNTIME override for the runtime bin', () => {
    const prev = process.env.DSH_REPL_RUNTIME
    try {
      process.env.DSH_REPL_RUNTIME = '/opt/agents/bin.js'
      expect(runtimeBin()).toBe('/opt/agents/bin.js')
      process.env.DSH_REPL_RUNTIME = 'dsh-jsonrpc-agent'
      expect(runtimeBin()).toBe('dsh-jsonrpc-agent')
    } finally {
      if (prev === undefined) delete process.env.DSH_REPL_RUNTIME
      else process.env.DSH_REPL_RUNTIME = prev
    }
  })
  it('honors DSH_REPL_CONFIG override for the interactive config', () => {
    const prev = process.env.DSH_REPL_CONFIG
    try {
      process.env.DSH_REPL_CONFIG = '/tmp/my-config.yml'
      expect(interactiveConfig()).toBe('/tmp/my-config.yml')
    } finally {
      if (prev === undefined) delete process.env.DSH_REPL_CONFIG
      else process.env.DSH_REPL_CONFIG = prev
    }
  })
  it('defaults the interactive config into the repo examples dir when unset', () => {
    const prev = process.env.DSH_REPL_CONFIG
    try {
      delete process.env.DSH_REPL_CONFIG
      expect(interactiveConfig()).toMatch(/examples[/\\]jsonrpc-agent[/\\]interactive\.cordis\.yml$/)
    } finally {
      if (prev === undefined) delete process.env.DSH_REPL_CONFIG
      else process.env.DSH_REPL_CONFIG = prev
    }
  })
})

describe('describeToolArgs', () => {
  it('returns "" for absent arguments', () => {
    expect(describeToolArgs(undefined)).toBe('')
    expect(describeToolArgs(null)).toBe('')
  })
  it('round-trips a JSON string to compact form', () => {
    expect(describeToolArgs('{"a":1}')).toBe('{"a":1}')
  })
  it('stringifies an object argument', () => {
    expect(describeToolArgs({ a: 1 })).toBe('{"a":1}')
  })
  it('keeps non-JSON text verbatim', () => {
    expect(describeToolArgs('just raw text')).toBe('just raw text')
  })
  it('truncates overlong preiews with an ellipsis', () => {
    const long = 'x'.repeat(500)
    const out = describeToolArgs(long)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThan(250)
  })
})

describe('briefToolArgs', () => {
  it('returns "" for absent or empty args', () => {
    expect(briefToolArgs(undefined)).toBe('')
    expect(briefToolArgs(null)).toBe('')
    expect(briefToolArgs('')).toBe('')
    expect(briefToolArgs('{}')).toBe('')
  })
  it('prefers a known short key over the raw JSON', () => {
    expect(briefToolArgs('{"command":"ls -la"}')).toBe('ls -la')
    expect(briefToolArgs({ path: 'src/a.ts', limit: 200 })).toBe('src/a.ts')
  })
  it('falls back to compact text/JSON and truncates', () => {
    expect(briefToolArgs('just raw text', 20)).toBe('just raw text')
    expect(briefToolArgs('x'.repeat(50), 10)).toBe('xxxxxxxxxx…')
  })
  it('normalizes embedded newlines to spaces', () => {
    expect(briefToolArgs('a\nb\nc', 10)).toBe('a b c')
  })
})

describe('summarizeToolResult', () => {
  it('joins and normalizes text blocks', () => {
    const r = summarizeToolResult({
      message: { content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }] },
    })
    expect(r).toEqual({ summary: 'hello world', error: false })
  })
  it('flattens whitespace across blocks', () => {
    const r = summarizeToolResult({ message: { content: [{ type: 'text', text: 'a  \n  b' }] } })
    expect(r.summary).toBe('a b')
  })
  it('flags isError blocks', () => {
    const r = summarizeToolResult({ message: { content: [{ type: 'text', text: 'boom', isError: true }] } })
    expect(r.error).toBe(true)
  })
  it('truncates above the default limit', () => {
    const r = summarizeToolResult({ message: { content: [{ type: 'text', text: 'y'.repeat(800) }] } })
    expect(r.summary.length).toBeLessThan(400)
    expect(r.summary.endsWith('…')).toBe(true)
  })
  it('exposes data.error without a message', () => {
    const r = summarizeToolResult({ error: { code: 7 } })
    expect(r).toEqual({ summary: '', error: false })
  })
})

describe('isAbnormalTurnEnd', () => {
  it('accepts normal completion reasons', () => {
    for (const reason of ['completed', 'success', 'stop']) {
      expect(isAbnormalTurnEnd(reason)).toBe(false)
    }
  })
  it('accepts structured { kind } normal reasons', () => {
    expect(isAbnormalTurnEnd({ kind: 'completed' })).toBe(false)
  })
  it('flags abnormal / unknown / absent reasons', () => {
    expect(isAbnormalTurnEnd({ kind: 'max_tokens' })).toBe(true)
    expect(isAbnormalTurnEnd('error')).toBe(true)
    expect(isAbnormalTurnEnd(undefined)).toBe(false)
    expect(isAbnormalTurnEnd(null)).toBe(false)
  })
})

describe('shouldFlushStream', () => {
  it('flushes on the first delta (no prior flush)', () => {
    expect(shouldFlushStream(1_000, undefined)).toBe(true)
  })
  it('does not flush again within the coalesce window', () => {
    const last = 5_000
    expect(shouldFlushStream(last + STREAM_FLUSH_MS - 1, last)).toBe(false)
    expect(shouldFlushStream(last + 1, last)).toBe(false)
  })
  it('flushes once the coalesce window elapses', () => {
    const last = 5_000
    expect(shouldFlushStream(last + STREAM_FLUSH_MS, last)).toBe(true)
    expect(shouldFlushStream(last + STREAM_FLUSH_MS + 50, last)).toBe(true)
  })
})

describe('repoRoot override', () => {
  it('honors DSH_REPL_ROOT when set', () => {
    const prev = process.env.DSH_REPL_ROOT
    try {
      process.env.DSH_REPL_ROOT = '/tmp/explicit-root'
      expect(repoRoot()).toBe('/tmp/explicit-root')
    } finally {
      if (prev === undefined) delete process.env.DSH_REPL_ROOT
      else process.env.DSH_REPL_ROOT = prev
    }
  })
})

describe('loadModelsFromConfig — tolerates invalid provider/model shapes', () => {
  it('returns [] for a non-string config', () => {
    expect(loadModelsFromConfig(123 as unknown as string)).toEqual([])
  })
  it('returns [] for an llm-pi-ai entry without a config block', () => {
    expect(loadModelsFromConfig('- id: llm-pi-ai\n  name: x')).toEqual([])
  })
  it('returns [] when the parsed document is not an array', () => {
    expect(loadModelsFromConfig('just: a: mapping')).toEqual([])
  })
  it('tolerates null top-level entries in the document', () => {
    const models = loadModelsFromConfig(`
- null
- bare-string-entry
- id: other-plugin
  name: unrelated
- id: llm-pi-ai
  config:
    providers:
      p:
        models:
          - id: m
`)
    expect(models.map(m => m.id)).toEqual(['m'])
  })
  it('treats a non-numeric contextWindow as undefined', () => {
    const models = loadModelsFromConfig(`
- id: llm-pi-ai
  config:
    providers:
      p:
        models:
          - id: m
            contextWindow: not-a-number
`)
    expect(models[0]?.contextWindow).toBeUndefined()
  })
  it('skips null and non-object provider configs', () => {
    const models = loadModelsFromConfig(`
- id: llm-pi-ai
  config:
    providers:
      good:
        models:
          - id: kept
      badNull: null
      badString: "not-an-object"
`)
    expect(models.map(m => m.id)).toEqual(['kept'])
  })
  it('skips null and non-object model entries', () => {
    const models = loadModelsFromConfig(`
- id: llm-pi-ai
  config:
    providers:
      p:
        models:
          - null
          - "not-an-object"
          - id: valid
`)
    expect(models.map(m => m.id)).toEqual(['valid'])
  })
})

describe('summarizeToolResult — non-object message tolerance', () => {
  it('returns empty when message is not an object', () => {
    expect(summarizeToolResult({ message: 'not-an-object' })).toEqual({ summary: '', error: false })
    expect(summarizeToolResult({ message: 42 })).toEqual({ summary: '', error: false })
  })
  it('skips null/non-object content blocks and non-text blocks', () => {
    const r = summarizeToolResult({ message: { content: [null, 'str', { type: 'image' }, { type: 'text', text: 'only-text' }] } })
    expect(r.summary).toBe('only-text')
  })
  it('flags an error block alongside text', () => {
    const r = summarizeToolResult({ message: { content: [{ type: 'text', text: 'ok' }, { type: 'text', text: 'err', isError: true }] } })
    expect(r.error).toBe(true)
    expect(r.summary).toBe('ok err')
  })
})

describe('statsOnEvent — request/context and empty-data branches', () => {
  it('uses the empty default when event data is absent', () => {
    const stats = createStats()
    // request/context with no data → no change, no throw
    expect(statsOnEvent(stats, { type: 'request/context', time: 1 })).toBe(false)
  })
  it('updates only the model when contextWindow is absent', () => {
    const stats = createStats('p', 'm')
    expect(statsOnEvent(stats, { type: 'request/context', time: 1, data: { model: 'kimi-k3' } })).toBe(true)
    expect(stats.modelName).toBe('kimi-k3')
    expect(stats.contextWindow).toBeUndefined()
  })
  it('updates only contextWindow when model is absent', () => {
    const stats = createStats('p', 'm')
    expect(statsOnEvent(stats, { type: 'request/context', time: 1, data: { contextWindow: 99 } })).toBe(true)
    expect(stats.contextWindow).toBe(99)
  })
})

describe('formatStatsLine — default style', () => {
  it('renders with the built-in no-color default style', () => {
    const stats = createStats('p', 'm')
    stats.turns = 1
    stats.steps = 1
    stats.billedInput = 100
    stats.outputTokens = 10
    const line = formatStatsLine(stats)
    expect(line).toContain('↑ 100 · ↓ 10')
  })
})

describe('fixCommand — no matching known command', () => {
  it('returns the input verbatim when no known command is a suffix', () => {
    expect(fixCommand('/zzznotacommand', ['compact', 'new'])).toBe('/zzznotacommand')
  })
})

describe('nextToolCardVisibility', () => {
  it('cycles collapsed → expanded → hidden → collapsed', () => {
    expect(nextToolCardVisibility('collapsed')).toBe('expanded')
    expect(nextToolCardVisibility('expanded')).toBe('hidden')
    expect(nextToolCardVisibility('hidden')).toBe('collapsed')
  })

  it('matches the exported cycle order', () => {
    expect(TOOL_CARD_CYCLE).toEqual(['collapsed', 'expanded', 'hidden'])
  })

  it('starts from collapsed for unknown or empty input', () => {
    expect(nextToolCardVisibility(undefined)).toBe('collapsed')
    expect(nextToolCardVisibility('bogus')).toBe('collapsed')
    expect(nextToolCardVisibility('')).toBe('collapsed')
  })
})

describe('collapseToolText', () => {
  it('returns undefined for bodies that fit the head/tail budget', () => {
    // 4 head + 3 tail + 1 elision room = 8 lines; a 7-line body fits unelided.
    const text = ['1', '2', '3', '4', '5', '6', '7'].join('\n')
    expect(collapseToolText(text)).toBeUndefined()
  })

  it('elides an over-budget body into head … tail', () => {
    const text = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n')
    const got = collapseToolText(text)
    expect(got).toContain('\u2026')
    expect(got?.split('\n').length).toBe(COLLAPSE_HEAD_LINES + COLLAPSE_TAIL_LINES + 1)
    expect(got?.startsWith('a\nb\nc\nd')).toBe(true)
    expect(got?.endsWith('h\ni\nj')).toBe(true)
  })

  it('honors a custom head/tail scale', () => {
    const text = ['1', '2', '3', '4', '5', '6'].join('\n')
    const got = collapseToolText(text, { head: 1, tail: 1 })
    expect(got).toBe('1\n\u2026\n6')
  })

  it('trims trailing empty lines before deciding elision', () => {
    // Body lines that end without elision budget pressure (trailing blanks would
    // otherwise count toward the line total and force an elision).
    const text = 'ok\n\n'
    expect(collapseToolText(text, { head: 4, tail: 3 })).toBeUndefined()
  })

  it('keeps a marker line even when head and tail are both empty', () => {
    expect(collapseToolText('a\nb', { head: 0, tail: 0 })).toBe('\u2026')
  })
})

describe('bracketScrollAction', () => {
  it('pages up/down on [ and ] while the editor draft is empty', () => {
    expect(bracketScrollAction('[', true)).toBe('up')
    expect(bracketScrollAction(']', true)).toBe('down')
  })

  it('falls back to literal typing once a draft exists', () => {
    expect(bracketScrollAction('[', false)).toBeUndefined()
    expect(bracketScrollAction(']', false)).toBeUndefined()
  })

  it('ignores non-single-char sequences so bracketed paste stays text', () => {
    expect(bracketScrollAction('\x1b[200~[x]\x1b[201~', true)).toBeUndefined()
    expect(bracketScrollAction('', true)).toBeUndefined()
    expect(bracketScrollAction('a', true)).toBeUndefined()
  })
})
