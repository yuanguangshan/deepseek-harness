/**
 * dsh-repl pure-logic core: no UI or terminal dependency, independently unit-testable.
 *
 * - formatting: fmtTokens / fmtDuration
 * - model registry: loadModelsFromConfig / pickRoute
 * - session stats: createStats / statsOnEvent / formatStatsLine
 * - streaming flush cadence: STREAM_FLUSH_MS / shouldFlushStream
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { load as yamlLoad, Schema as YamlSchema, Type as YamlType } from 'js-yaml'

// ---- repository-root derivation (survives moving the project tree; override with DSH_REPL_ROOT) ----
// This file lives at <root>/apps/repl/src/core.ts; the repository root is two levels above apps/repl.
export function repoRoot(): string {
  const override = process.env.DSH_REPL_ROOT
  if (override !== undefined && override.trim() !== '') return override
  return dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
}

/** Runtime code entry (the jsonrpc-demo compiled artifact). */
export function runtimeBin(root = repoRoot()): string {
  return join(root, 'packages/examples/jsonrpc-demo/lib/bin.js')
}

/** Interactive cordis config path (override with DSH_REPL_CONFIG). */
export function interactiveConfig(root = repoRoot()): string {
  return process.env.DSH_REPL_CONFIG ?? join(root, 'examples/jsonrpc-agent/interactive.cordis.yml')
}

// cordis.yml uses !!js expression tags; parse them as plain strings (models are read-only).
const cordisSchema = new YamlSchema({ explicit: [new YamlType('tag:yaml.org,2002:js', { kind: 'scalar', construct: (s: unknown): unknown => s })] })

// ---- formatting ----

/** Compact token count: 517 / 12.3K / 517K / 1.2M (one decimal below three digits). */
export function fmtTokens(n: number): string {
  const scaled = (v: number): string => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** Compact duration: seconds under a minute, then m+s. */
export function fmtDuration(ms: number): string {
  const s = ms / 1_000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/** Truncation cap for tool-argument previews. */
const TOOL_PREVIEW_LIMIT = 200

/**
 * Serialize tool/call arguments into a compact preview; non-JSON text is kept verbatim and truncated when overlong.
 * @param args - the tool event data.arguments (already a string or an object).
 */
export function describeToolArgs(args: unknown): string {
  if (args === undefined || args === null) return ''
  let text = typeof args === 'string' ? args : JSON.stringify(args)
  try { text = JSON.stringify(JSON.parse(text)) } catch { /* keep original text */ }
  if (text.length > TOOL_PREVIEW_LIMIT) text = text.slice(0, TOOL_PREVIEW_LIMIT) + '…'
  return text
}

/**
 * Reduce a tool/result to a one-line summary plus an error flag. All REPLs share one truncation policy.
 * @param data - the tool/result event data (message / error).
 * @param limit - the summary length cap.
 * @returns `{ summary, error }`; summary is empty when there is no text and no error.
 */
export function summarizeToolResult(data: unknown, limit = 300): { summary: string; error: boolean } {
  const msg = (data as { message?: unknown } | null | undefined)?.message
  let error = false
  const textBlocks: string[] = []
  if (typeof msg === 'object' && msg !== null && Array.isArray((msg as { content?: unknown }).content)) {
    for (const b of (msg as { content: unknown[] }).content) {
      if (b === null || typeof b !== 'object') continue
      const block = b as { type?: string; text?: unknown; isError?: unknown }
      if (block.type === 'text' && typeof block.text === 'string') textBlocks.push(block.text)
      if (block.isError === true) error = true
    }
  }
  let summary = textBlocks.join(' ').replace(/\s+/g, ' ').trim()
  if (summary.length > limit) summary = summary.slice(0, limit) + '…'
  return { summary, error }
}

/** Whether turn/end ended abnormally (reason.kind not in the legal set). Legal: completed / success / stop. */
export function isAbnormalTurnEnd(reason: unknown): boolean {
  const kind = reason !== null && typeof reason === 'object' ? (reason as { kind?: unknown }).kind : reason
  return kind !== undefined && kind !== null && kind !== 'completed' && kind !== 'success' && kind !== 'stop'
}

// ---- model registry ----

/** One model entry parsed from a cordis.yml provider config. */
export interface ModelEntry {
  readonly id: string
  readonly name: string
  readonly contextWindow: number | undefined
  readonly maxTokens: number | undefined
  readonly provider: string
}

/**
 * Parse the llm-pi-ai providers from the runtime config (cordis.yml), merging every route's models.
 * When the same model id appears in multiple routes the first one wins (config order = responses first).
 * @param configText - the cordis.yml text.
 */
/** Coerce a yaml field to a number; empty/invalid returns undefined (under the custom js-yaml schema a number may arrive as a string). */
function numOrUndefined(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function loadModelsFromConfig(configText: string): ModelEntry[] {
  if (typeof configText !== 'string' || configText.trim() === '') return []
  let doc: unknown
  try {
    doc = yamlLoad(configText, { schema: cordisSchema })
  } catch {
    return []
  }
  // Filter to object entries; null/primitive entries in a malformed-but-parsed document are skipped.
  /* v8 ignore next -- the null/primitive-object short-circuit only guards malformed parsed docs */
  const entries = Array.isArray(doc) ? doc.filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object') : []
  const entry = entries.find(e => e.id === 'llm-pi-ai')
  const providers = (entry?.config as { providers?: unknown } | undefined)?.providers
  if (typeof providers !== 'object' || providers === null) return []
  const seen = new Set<string>()
  const models: ModelEntry[] = []
  for (const [provider, cfg] of Object.entries(providers as Record<string, unknown>)) {
    if (cfg === null || typeof cfg !== 'object' || !Array.isArray((cfg as { models?: unknown }).models)) continue
    for (const m of (cfg as { models: unknown[] }).models) {
      if (m === null || typeof m !== 'object') continue
      const model = m as { id?: unknown; name?: unknown; contextWindow?: unknown; maxTokens?: unknown }
      if (typeof model.id !== 'string' || model.id === '') continue
      if (seen.has(model.id)) continue
      seen.add(model.id)
      models.push({
        id: model.id,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
        contextWindow: numOrUndefined(model.contextWindow),
        maxTokens: numOrUndefined(model.maxTokens),
        provider,
      })
    }
  }
  return models
}

/**
 * Pick the route (interface) for a model id: whichever route declares it, else the fallback.
 * @param modelId - the target model id.
 * @param modelList - the result of loadModelsFromConfig.
 * @param fallback - the default route when no entry matches.
 */
export function pickRoute(modelId: string, modelList: readonly ModelEntry[] | undefined, fallback: string): string {
  const found = (modelList ?? []).find(m => m.id === modelId)
  return found?.provider ?? fallback
}

// ---- session stats ----

/** Stats object shape (including timing scratch state). */
export interface ReplStats {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
  billedInput: number
  outputTokens: number
  cacheRead: number
  contextWindow: number | undefined
  lastBilledInput: number
  providerName: string
  modelName: string
  // timing scratch state
  stepStart: number | undefined
  decodeStart: number | undefined
  toolStart: number | undefined
  sawChunk: boolean
}

/** Create a fresh stats object (including timing scratch state). */
export function createStats(providerName = '', modelName = ''): ReplStats {
  return {
    turns: 0, steps: 0,
    llmMs: 0, toolMs: 0,
    ttftMs: 0, ttftSteps: 0,
    decodeMs: 0, decodeTokens: 0,
    billedInput: 0, outputTokens: 0, cacheRead: 0,
    contextWindow: undefined,
    lastBilledInput: 0,
    providerName, modelName,
    // timing scratch state
    stepStart: undefined, decodeStart: undefined, toolStart: undefined, sawChunk: false,
  }
}

/** Minimal event shape the stats reducer reads from a session.event notification. */
export interface StatsEvent {
  readonly type: string
  readonly time: number
  readonly data?: unknown
}

/**
 * Apply one session event to a stats object (in place).
 * @param stats - the result of createStats.
 * @param event - `{ type, time, data }`.
 * @returns whether anything changed (drives whether the UI re-renders the stats line).
 */
export function statsOnEvent(stats: ReplStats, event: StatsEvent): boolean {
  const { type, time, data } = event
  const d = (data ?? {}) as Record<string, unknown>
  switch (type) {
    case 'turn/start':
      stats.turns += 1
      return true
    case 'step/start':
      stats.steps += 1
      stats.stepStart = time
      stats.decodeStart = undefined
      stats.sawChunk = false
      return true
    case 'assistant/chunk': {
      const chunk = d.chunk
      if (chunk !== null && chunk !== undefined && typeof chunk === 'object' && !stats.sawChunk && stats.stepStart !== undefined) {
        stats.sawChunk = true
        stats.ttftMs += Math.max(0, time - stats.stepStart)
        stats.ttftSteps += 1
        stats.decodeStart = time
        return true
      }
      return false
    }
    case 'assistant/message': {
      let changed = false
      if (stats.stepStart !== undefined) {
        stats.llmMs += Math.max(0, time - stats.stepStart)
        changed = true
        if (stats.decodeStart !== undefined) {
          stats.decodeMs += Math.max(0, time - stats.decodeStart)
        }
      }
      const usage = d.usage
      if (usage !== null && usage !== undefined && typeof usage === 'object') {
        const usageRecord = usage as Record<string, unknown>
        const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
        const input = num(usageRecord.inputTokens) + num(usageRecord.cacheReadTokens) + num(usageRecord.cacheWriteTokens)
        const out = num(usageRecord.outputTokens)
        stats.billedInput += input
        stats.outputTokens += out
        stats.cacheRead += num(usageRecord.cacheReadTokens)
        stats.lastBilledInput = input
        if (stats.decodeStart !== undefined) stats.decodeTokens += out
        changed = true
      }
      return changed
    }
    case 'request/context': {
      let changed = false
      if (typeof d.contextWindow === 'number') {
        stats.contextWindow = d.contextWindow
        changed = true
      }
      if (typeof d.model === 'string' && d.model !== '') {
        stats.modelName = d.model
        stats.providerName = typeof d.provider === 'string' && d.provider !== '' ? d.provider : stats.providerName
        changed = true
      }
      return changed
    }
    case 'tool/call':
      stats.toolStart = time
      return true
    case 'tool/result':
      if (stats.toolStart !== undefined) {
        stats.toolMs += Math.max(0, time - stats.toolStart)
        stats.toolStart = undefined
        return true
      }
      return false
    default:
      return false
  }
}

// ---- streaming flush cadence ----

/**
 * Coalesce window for streaming assistant Markdown re-render: pi-tui Markdown has no incremental
 * API, so deltas are buffered and the full text is re-parsed at most this often.
 */
export const STREAM_FLUSH_MS = 50

/**
 * Decide whether a buffered assistant stream should flush (re-render) now.
 * Pure in event time: terminal transitions (assistant/message, turn/end, new assistant block) always flush and bypass this check.
 * @param now - the current event time.
 * @param lastFlush - the last flush event time, or undefined when nothing has flushed yet.
 */
export function shouldFlushStream(now: number, lastFlush: number | undefined): boolean {
  return lastFlush === undefined || now - lastFlush >= STREAM_FLUSH_MS
}

// ---- stats-line rendering (style is injectable: the UI layer passes ANSI color functions) ----

/** Style function set injected by the UI layer; default is no color. */
export interface StatsStyle {
  gray: (s: string) => string
  cyan: (s: string) => string
  green: (s: string) => string
  yellow: (s: string) => string
}

const noStyle = (s: string): string => s
const NO_STYLE: StatsStyle = { gray: noStyle, cyan: noStyle, green: noStyle, yellow: noStyle }

/**
 * Render the bottom stats-line string (mirrors the web StatsLine).
 * @param stats - the result of createStats.
 * @param st - optional style function set; defaults to no color.
 * @returns the stats string; empty for a fresh session.
 */
export function formatStatsLine(stats: ReplStats, st: StatsStyle = NO_STYLE): string {
  const g: string[] = []
  if (stats.steps > 0) {
    g.push(`${stats.turns} ${st.gray('轮')} · ${stats.steps} ${st.gray('步')}`)
    const d: string[] = []
    if (stats.llmMs > 0) d.push(`${st.cyan('LLM')} ${fmtDuration(stats.llmMs)}`)
    if (stats.toolMs > 0) d.push(`${st.cyan('工具调用')} ${fmtDuration(stats.toolMs)}`)
    if (d.length > 0) g.push(d.join(' · '))
    const sp: string[] = []
    if (stats.ttftSteps > 0) sp.push(`${st.cyan('首 token 平均')} ${fmtDuration(stats.ttftMs / stats.ttftSteps)}`)
    if (stats.decodeMs > 0) {
      const tps = stats.decodeTokens / (stats.decodeMs / 1_000)
      sp.push(`${Math.round(tps * 10) / 10} ${st.cyan('tok/s')}`)
    }
    if (sp.length > 0) g.push(sp.join(' · '))
  }
  if (stats.billedInput > 0 || stats.outputTokens > 0) {
    if (stats.cacheRead > 0) {
      g.push(`${st.green('缓存命中')} ${Math.round(stats.cacheRead / stats.billedInput * 100)}%`)
    }
    g.push(`${st.gray('输入')} ${fmtTokens(stats.billedInput)} tokens · ${st.gray('输出')} ${fmtTokens(stats.outputTokens)} tokens`)
    if (stats.contextWindow !== undefined && stats.lastBilledInput > 0) {
      const pct = Math.min(100, Math.round(stats.lastBilledInput / stats.contextWindow * 100))
      g.push(`${st.yellow('ctx')} ${pct}%`)
    }
  }
  return g.join(`  ${st.gray('|')}  `)
}

/** Model tag (right side of the status bar): provider · model. */
export function formatModelTag(providerName: string, modelName: string): string {
  return `${providerName} · ${modelName}`
}

// ---- commands ----

/**
 * Repair the duplicated-insertion from autocomplete: when autocomplete hands Enter a selected item,
 * the submitted value can become /compcompact; take the part of the command name ending in a known command.
 * @param t - the submitted text.
 * @param knownCommands - the known command names (without /).
 */
export function fixCommand(t: string, knownCommands: readonly string[]): string {
  const m = t.match(/^\/([^\s]+)([\s\S]*)$/)
  if (m === null) return t
  // [^\s]+ guarantees at least one captured char, so groups 1 and 2 are always defined; the
  // nullish fallbacks only satisfy noUncheckedIndexedAccess and never execute at runtime.
  /* v8 ignore next */
  const raw = m[1] ?? ''
  /* v8 ignore next */
  const rest = m[2] ?? ''
  const sorted = [...knownCommands].sort((a, b) => b.length - a.length)
  for (const known of sorted) {
    if (raw.endsWith(known)) return '/' + known + rest
  }
  return t
}
