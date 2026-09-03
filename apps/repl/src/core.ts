/**
 * dsh-repl pure-logic core: no UI or terminal dependency, independently unit-testable.
 *
 * - formatting: fmtTokens / fmtDuration
 * - model registry: loadModelsFromConfig / pickRoute
 * - session stats: createStats / statsOnEvent / formatStatsFields
 * - streaming flush cadence: STREAM_FLUSH_MS / shouldFlushStream
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { load as yamlLoad, Schema as YamlSchema, Type as YamlType } from 'js-yaml'
// pi-tui's keys module is pure sequence parsing (no terminal side effects), so it is
// safe to use in this UI-free core.
import { isKeyRelease, matchesKey } from '@earendil-works/pi-tui'

// ---- repository-root derivation (survives moving the project tree; override with DSH_REPL_ROOT) ----
// This file lives at <root>/apps/repl/src/core.ts; the repository root is two levels above apps/repl.
export function repoRoot(): string {
  const override = process.env.DSH_REPL_ROOT
  if (override !== undefined && override.trim() !== '') return override
  return dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
}

/**
 * Runtime code entry (the jsonrpc-demo compiled artifact).
 *
 * In a standalone, separately-installed `dsh-repl` package the agent runtime
 * (the `dsh-jsonrpc-agent` process and its cordis plugin closure) is NOT
 * bundled — the user installs it on the target machine themselves and points
 * this package at it:
 *
 * - `DSH_REPL_RUNTIME` — absolute path to the agent JS entry (e.g.
 *   `<npmRoot>/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/bin.js`), or a bare
 *   command name resolved from `PATH`.
 * - `DSH_REPL_ROOT` — a runtime install root laid out like the monorepo
 *   (`packages/examples/jsonrpc-demo/lib/bin.js`); the `runtimeBin` default.
 *
 * When neither is set we fall back to the monorepo-internal artifact so
 * in-repository development keeps working unmodified.
 */
export function runtimeBin(root = repoRoot()): string {
  const override = process.env.DSH_REPL_RUNTIME
  if (override !== undefined && override.trim() !== '') return override.trim()
  return join(root, 'packages/examples/jsonrpc-demo/lib/bin.js')
}

/**
 * Interactive cordis config path. A standalone install serves the config from
 * `DSH_REPL_CONFIG` (the user-authored file describing their installed agent
 * composition); absent that we fall back to the monorepo examples so in-repo
 * development works unmodified.
 */
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
 * A short, single-line hint of what a tool call is about, for the live status-bar
 * header (e.g. `bash "ls -la"`). Prefers a known short arg key (command/path/file),
 * falls back to the compact text/JSON, and clamps to `limit` chars.
 */
export function briefToolArgs(args: unknown, limit = 14): string {
  if (args === undefined || args === null) return ''
  if (typeof args === 'string' && args.trim() === '') return ''
  // A non-string arg always stringifies non-empty here (plain objects/arrays);
  // JSON.stringify of functions/symbols yields `undefined`, so `text` falls back
  // to the raw-string branch of clampBrief via String() coercion below.
  const text = typeof args === 'string' ? args.trim() : (JSON.stringify(args) ?? String(args))
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>
      for (const key of ['command', 'path', 'file', 'query']) {
        const v = rec[key]
        if (typeof v === 'string' && v.trim() !== '') return clampBrief(v.trim(), limit)
      }
      // No known short key: only show the JSON when it carries real content, so an
      // empty {}/(no args) doesn't clutter the header.
      if (Object.values(rec).every(v => v == null)) return ''
    }
  } catch { /* keep JSON text */ }
  return clampBrief(text.replace(/\n/g, ' '), limit)
}

/** Trim `text` with an ellipsis once it exceeds `limit` chars. */
function clampBrief(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Per-turn delta snapshot driving the end-of-turn pet banter. */
export interface TurnDelta {
  /** Steps (tool + reasoning + answer steps) taken this turn. */
  readonly steps: number
  /** Cumulative LLM time (ms) spent this turn. */
  readonly llmMs: number
  /** Cumulative tool time (ms) spent this turn. */
  readonly toolMs: number
  /** Output tokens generated this turn. */
  readonly outputTokens: number
}

/**
 * A short, cheerful end-of-turn "战报" from the pet, summarizing what just happened.
 * Pure and deterministic so it is unit-testable; stays compact for the status row.
 */
export function formatTurnBanter(d: TurnDelta): string {
  if (d.steps === 0) {
    return d.outputTokens > 0 ? '本轮没说数字，但交了一份满分答案~' : '这轮空手而归，比躺平还省。'
  }
  const score = `${d.steps} 步 · LLM ${fmtDuration(d.llmMs)} · tools ${fmtDuration(d.toolMs)}`
  const mood = d.toolMs > d.llmMs
    ? '工具搬得比想得多，像模像样。'
    : d.llmMs > 30_000
      ? '思考得够久，有那味儿了。'
      : d.steps > 6
        ? '节奏不错，干活利索。'
        : '轻装上阵，漂亮。'
  return `本轮 ${score} ─ ${mood}`
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
      // Allow the same model id in different providers (e.g. opencode-go vs meta)
      const key = `${provider}:${model.id}`
      if (seen.has(key)) continue
      seen.add(key)
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

/**
 * Live phase of the current turn, shown next to the running elapsed clock:
 * - `'idle'` — no turn in flight (e.g. between turns / at startup);
 * - `'thinking'` — a step is running, first token not yet produced;
 * - `'responding'` — text is streaming (decode started);
 * - `'tools'` — a tool call is in flight.
 */
export type LivePhase = 'idle' | 'thinking' | 'responding' | 'tools'

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
  livePhase: LivePhase
  /** Epoch ms when this stats/session object was created (start of the session clock). */
  sessionStart: number
  /** Name of the tool currently executing (shown in the live header during the tools phase). */
  currentToolName: string
  /** Brief single-line preview of the current tool's arguments (empty when none/nonextractible). */
  currentToolArgs: string
  /** Tail of the current step's streamed reasoning, for the live "思考：…" header. */
  reasoningPreview: string
  // timing scratch state
  stepStart: number | undefined
  decodeStart: number | undefined
  toolStart: number | undefined
  sawChunk: boolean
}

/** Max chars of streamed reasoning kept for the live "思考：…" header. */
export const REASONING_PREVIEW_MAX = 24

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
    livePhase: 'idle',
    sessionStart: Date.now(),
    currentToolName: '',
    currentToolArgs: '',
    reasoningPreview: '',
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
      stats.livePhase = 'thinking'
      stats.reasoningPreview = ''
      return true
    case 'step/start':
      stats.steps += 1
      stats.stepStart = time
      stats.decodeStart = undefined
      stats.sawChunk = false
      stats.reasoningPreview = ''
      stats.livePhase = 'thinking'
      return true
    case 'assistant/chunk': {
      const chunk = d.chunk
      if (chunk !== null && chunk !== undefined && typeof chunk === 'object') {
        const c = chunk as { type?: unknown; text?: unknown }
        // Reasoning stays in "thinking" (no answer token yet) and feeds a short
        // live preview so the header can show "思考：…". It does not count toward TTFT.
        if (c.type === 'reasoning-delta' && typeof c.text === 'string' && c.text.trim() !== '') {
          stats.reasoningPreview = (stats.reasoningPreview + c.text).slice(-REASONING_PREVIEW_MAX)
          return true
        }
        // A real text token flips the phase to responding (first token marks TTFT).
        if (!stats.sawChunk && stats.stepStart !== undefined) {
          stats.sawChunk = true
          stats.ttftMs += Math.max(0, time - stats.stepStart)
          stats.ttftSteps += 1
          stats.decodeStart = time
          stats.livePhase = 'responding'
          return true
        }
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
      stats.livePhase = 'tools'
      stats.currentToolName = typeof d.name === 'string' && d.name !== '' ? d.name : '?'
      stats.currentToolArgs = briefToolArgs(d.arguments)
      return true
    case 'tool/result':
      if (stats.toolStart !== undefined) {
        stats.toolMs += Math.max(0, time - stats.toolStart)
        stats.toolStart = undefined
        stats.currentToolName = ''
        stats.currentToolArgs = ''
        stats.livePhase = 'thinking' // the step resumes after the tool returns
        return true
      }
      return false
    case 'turn/end':
      stats.livePhase = 'idle'
      stats.currentToolName = ''
      stats.currentToolArgs = ''
      stats.reasoningPreview = ''
      return true
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
  red: (s: string) => string
}

const noStyle = (s: string): string => s
const NO_STYLE: StatsStyle = { gray: noStyle, cyan: noStyle, green: noStyle, yellow: noStyle, red: noStyle }

// ---- context-window pressure (status bar coloring + one-shot transcript warning) ----

/**
 * Context-window pressure tiers over `lastBilledInput / contextWindow`:
 * - `'ok'`       — below the warn threshold (or not measurable),
 * - `'warn'`     — warn threshold reached; status bar turns yellow,
 * - `'critical'` — critical threshold reached; status bar turns red and the
 *   transcript gets one compact suggestion per turn.
 */
export type ContextPressure = 'ok' | 'warn' | 'critical'

/** Pressure tier of the latest request against the context window; not measurable → `'ok'`. */
export function contextPressure(stats: Pick<ReplStats, 'lastBilledInput' | 'contextWindow'>): ContextPressure {
  if (stats.contextWindow === undefined || stats.contextWindow <= 0 || stats.lastBilledInput <= 0) return 'ok'
  const ratio = stats.lastBilledInput / stats.contextWindow
  if (ratio >= CONTEXT_CRITICAL_RATIO) return 'critical'
  if (ratio >= CONTEXT_WARN_RATIO) return 'warn'
  return 'ok'
}

/**
 * Build the stats-line as an array of individually-styled fields (one metric per
 * element). Field granularity lets a status bar scroll horizontally without
 * slicing through ANSI or splitting a metric in half.
 * @param stats - the result of createStats.
 * @param st - optional style function set; defaults to no color.
 * @param now - wall-clock ms for the live session-duration field; defaults to Date.now().
 * @returns a (possibly empty) array of field strings.
 */
export function formatStatsFields(stats: ReplStats, st: StatsStyle = NO_STYLE, now: number = Date.now()): string[] {
  const g: string[] = []
  if (stats.steps > 0) {
    // Session clock: how long the user has been in this session, once any step has run.
    const sessionMs = Math.max(0, now - stats.sessionStart)
    if (sessionMs >= 1_000) g.push(`${st.gray('会话')} ${fmtDuration(sessionMs)}`)
    g.push(`${stats.turns} ${st.gray('轮')} · ${stats.steps} ${st.gray('步')}`)
    if (stats.llmMs > 0) g.push(`${st.cyan('LLM')} ${fmtDuration(stats.llmMs)}`)
    if (stats.toolMs > 0) g.push(`${st.cyan('tools')} ${fmtDuration(stats.toolMs)}`)
    if (stats.ttftSteps > 0) g.push(`${st.cyan('首token')} ${fmtDuration(stats.ttftMs / stats.ttftSteps)}`)
    if (stats.decodeMs > 0) {
      const tps = stats.decodeTokens / (stats.decodeMs / 1_000)
      g.push(`${Math.round(tps * 10) / 10} ${st.cyan('tok/s')}`)
    }
  }
  if (stats.billedInput > 0 || stats.outputTokens > 0) {
    if (stats.cacheRead > 0) {
      g.push(`${st.green('缓存')} ${Math.round(stats.cacheRead / stats.billedInput * 100)}%`)
    }
    g.push(`${st.gray('↑')} ${fmtTokens(stats.billedInput)} · ${st.gray('↓')} ${fmtTokens(stats.outputTokens)}`)
    if (stats.contextWindow !== undefined && stats.lastBilledInput > 0) {
      const pct = Math.min(100, Math.max(0, Math.round(stats.lastBilledInput / stats.contextWindow * 100)))
      const pctText = `${st.yellow('ctx ')}${formatPctBar(pct, 4)} ${pct}%`
      // Pressure colors the whole bar: yellow at the warn threshold, red past critical.
      g.push(contextPressure(stats) === 'critical' ? st.red(pctText) : pctText)
    }
  }
  return g
}

/** A compact ▓/░ progress bar for a 0–100 percentage, clamped to `width` cells. */
export function formatPctBar(pct: number, width = 4): string {
  const ratio = Math.min(1, Math.max(0, pct / 100))
  const filled = Math.round(ratio * width)
  return '▓'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

/**
 * Render the live phase indicator for the *current* turn: which stage the model
 * is in right now plus how long it has been there. Pure in a caller-supplied
 * clock (`now`, ms) so the UI can re-render elapsed time on a timer without
 * touching stats. Returns `undefined` when no turn is active.
 * @param stats - the result of createStats.
 * @param now - the current wall-clock ms (event clock or `Date.now()`).
 * @param st - optional style function set; defaults to no color.
 */
export function livePhaseText(stats: ReplStats, now: number, st: StatsStyle = NO_STYLE): string | undefined {
  if (stats.livePhase === 'idle') return undefined
  // The clock anchor for each phase: tools → toolStart; responding → decodeStart; thinking → stepStart.
  const start = stats.livePhase === 'tools'
    ? stats.toolStart
    : stats.livePhase === 'responding'
      ? stats.decodeStart
      : stats.stepStart
  const elapsed = start !== undefined && now >= start ? fmtDuration(now - start) : ''
  // In "tools" the tag names the tool + a brief args preview (e.g. "⚙ bash ls -la").
  // In "thinking", keep the status-bar label minimal: streamed reasoning is a
  // private process, so the default shows only "思考中" (never leaks the preview
  // text into the shared status line right under the todo strip). Re-enable the
  // live preview explicitly with DSH_TUI_SHOW_THINKING_PREVIEW=1.
  const showThinkingPreview = process.env.DSH_TUI_SHOW_THINKING_PREVIEW === '1'
  const tag = stats.livePhase === 'thinking'
    ? (showThinkingPreview && stats.reasoningPreview !== '' ? `思考：${stats.reasoningPreview}` : '思考中')
    : stats.livePhase === 'responding' ? '作答中'
      : stats.currentToolName !== ''
        ? `⚙ ${stats.currentToolName}${stats.currentToolArgs !== '' ? ` ${stats.currentToolArgs}` : ''}`
        : '工具调用中'
  return `${st.yellow(tag)}${elapsed !== '' ? ` ${elapsed}` : ''}`
}

/** Model tag (right side of the status bar): provider · model. */
export function formatModelTag(providerName: string, modelName: string): string {
  return `${providerName} · ${modelName}`
}

/** Direction of the status-bar metrics slide: toward later fields or back toward leading ones. */
export type SlideDirection = 1 | -1

/** The auto-slide window state after one step. */
export interface SlideState {
  /** Index of the first field shown in the window. */
  readonly start: number
  /** Next slide direction after this step. */
  readonly dir: SlideDirection
}

/**
 * Advance a horizontal status-bar metrics window one auto-slide tick, bouncing at
 * both edges so the window never slides past the last field and leaves the trailing
 * space half-empty: once the right-most field is already visible it reverses toward
 * the leading fields. When everything fits (the window at start 0 already reaches
 * the last field), the window stays pinned at the leading fields facing forward.
 *
 * Pure in a caller-supplied fit model — the terminal glue measures ANSI widths and
 * passes `reachLast`, keeping edge detection here deterministic and unit-testable.
 * @param start - index of the first field currently shown.
 * @param dir - current slide direction.
 * @param fieldCount - total number of metric fields.
 * @param reachLast - whether the window at the given `start` already shows the last field.
 */
export function stepSlideWindow(
  start: number,
  dir: SlideDirection,
  fieldCount: number,
  reachLast: (start: number) => boolean,
): SlideState {
  if (fieldCount <= 1) return { start, dir }
  // Everything fits → nothing to scroll; stay at the leading fields facing forward.
  if (reachLast(0)) return { start: 0, dir: 1 }
  let nextDir: SlideDirection = dir
  if (dir === 1 && reachLast(start)) {
    nextDir = -1 // the right-most field is visible; bounce back toward the leading fields
  } else if (dir === -1 && start <= 0) {
    nextDir = 1 // back at the leading edge; bounce forward again
  }
  return { start: Math.max(0, Math.min(fieldCount - 1, start + nextDir)), dir: nextDir }
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

// ---- paste coalescing (non-bracketed multi-line paste) ----

/**
 * Window (ms) within which successive single-line editor submits count as one
 * pasted block. Terminals/SSH clients that don't speak bracketed paste
 * (\x1b[200~ … \x1b[201~) deliver a multi-line paste as per-line keystrokes:
 * pi-tui's StdinBuffer splits the raw bytes into single-character events, so
 * every "\r" reaches the Editor as its own Enter press and would enqueue one
 * message per line. A quiet gap of this length flushes the merged block.
 */
export const PASTE_COALESCE_MS = 150

/** True when a burst submit belongs to the same paste stream, not a deliberate send.
 *  Slash commands always pass through immediately so command batches stay individual. */
export function shouldCoalesceSubmit(lastSubmitAt: number | null, now: number, text: string): boolean {
  if (text.startsWith('/')) return false
  return lastSubmitAt !== null && now - lastSubmitAt <= PASTE_COALESCE_MS
}

// ---- prompt history persistence (up/down arrows survive restarts) ----

/** Persisted prompt-history cap (pi-tui's in-editor cap is 100; disk keeps more headroom). */
export const PROMPT_HISTORY_MAX = 200

/** How many entries to replay into the editor at startup — matches pi-tui's internal cap. */
export const PROMPT_HISTORY_REPLAY = 100

/** Default prompt-history file under ~/.dsh-repl; tests inject explicit paths. */
export function promptHistoryPath(home: string = homedir()): string {
  return join(home, '.dsh-repl', 'history.json')
}

/**
 * Parse persisted history JSON (oldest → newest order). Dedupes by exact text,
 * keeping the latest occurrence's position; caps to the newest {@link PROMPT_HISTORY_MAX}.
 * Malformed input yields [].
 */
export function parsePromptHistory(text: string): string[] {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(doc)) return []
  const out: string[] = []
  for (const item of doc) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '') continue
    const existing = out.indexOf(trimmed)
    if (existing >= 0) out.splice(existing, 1)
    out.push(trimmed)
  }
  return out.length > PROMPT_HISTORY_MAX ? out.slice(out.length - PROMPT_HISTORY_MAX) : out
}

/** Serialize history entries oldest → newest as a JSON array. */
export function serializePromptHistory(entries: readonly string[]): string {
  return JSON.stringify(entries)
}

/** Load prompt history from disk; missing/corrupt file yields []. */
export function loadPromptHistoryFromDisk(path = promptHistoryPath()): string[] {
  try {
    return parsePromptHistory(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

/** Persist prompt history; best-effort — an unwritable location just skips saving. */
export function savePromptHistoryToDisk(entries: readonly string[], path = promptHistoryPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, serializePromptHistory(entries))
  } catch {
    // unreadable/unwritable path: persistence is optional, the session continues without it
  }
}

// ---- /help rendering ----

/** One row of the /help table (mirrors the autocomplete completion entries). */
export interface HelpCommandEntry {
  readonly value: string
  readonly description: string
}

/**
 * Render the /help command list. Server-routed commands and local commands are
 * grouped separately; plain text so it stays trivially testable.
 */
export function formatHelp(
  commands: readonly HelpCommandEntry[],
  serverCommands: ReadonlySet<string>,
): string {
  const width = Math.max(...commands.map(c => c.value.length)) + 1
  const line = (c: HelpCommandEntry): string => `  /${c.value.padEnd(width)}${c.description}`
  const isServer = serverCommands
  const local = commands.filter(c => !isServer.has(c.value))
  const remote = commands.filter(c => isServer.has(c.value))
  return [
    '本地命令:',
    ...local.map(line),
    '',
    '运行时命令（转发给 agent runtime）:',
    ...remote.map(line),
  ].join('\n')
}

// ---- /copy: last reply + code-block extraction ----

/**
 * Strip the display-only decorations the transcript renderer adds around an
 * assistant reply (ANSI colors and the `🐳 ` prefix) so `/copy` hands the
 * model's actual prose to the clipboard.
 */
export function cleanAssistantText(text: string): string {
  return text
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '') // SGR and other CSI sequences
    .replace(/^🐳\s*/, '')
    .trim()
}

/**
 * Extract the first fenced code block's body (` ```lang\n…\n``` `). The
 * language tag is dropped; an unterminated fence yields everything after the
 * opening line. `undefined` when the reply contains no fenced block.
 */
export function extractFirstCodeBlock(text: string): string | undefined {
  const match = /^```[^\n]*\n([\s\S]*?)(?:\n```|$)/m.exec(text)
  if (match === null || match[1] === undefined) return undefined
  const body = match[1].replace(/\n+$/, '')
  return body === '' ? undefined : body
}

/**
 * The payload `/copy` writes: the first fenced code block when the reply has
 * one (the common "give me this config" case), otherwise the whole clean text.
 * An empty reply yields `undefined` so the caller reports nothing to copy.
 */
export function copyPayload(text: string): string | undefined {
  const clean = cleanAssistantText(text)
  if (clean === '') return undefined
  return extractFirstCodeBlock(clean) ?? clean
}

// ---- per-turn cost estimate ----

/**
 * DeepSeek list price (CNY per million tokens) used for the per-turn cost line.
 * 2026-08 官网牌价；调价直接改这里。
 */
export const DEEPSEEK_CNY_PER_MTOK = { inputCacheMiss: 2, inputCacheHit: 0.2, output: 3 } as const

/** Context ratio that turns the status-bar ctx bar yellow. */
export const CONTEXT_WARN_RATIO = 0.75

/** Context ratio that turns the bar red and warns in the transcript. */
export const CONTEXT_CRITICAL_RATIO = 0.85

/** Estimate one turn's cost from its usage delta. `billedInput` counts ALL input
 * tokens (cache hits included), so the miss portion is billedInput − cacheRead.
 * Returns undefined for an empty/zero-cost turn.
 */
export function formatTurnCost(delta: { billedInput: number; outputTokens: number; cacheRead: number }): string | undefined {
  const miss = Math.max(0, delta.billedInput - delta.cacheRead)
  const cost = miss / 1e6 * DEEPSEEK_CNY_PER_MTOK.inputCacheMiss
    + delta.cacheRead / 1e6 * DEEPSEEK_CNY_PER_MTOK.inputCacheHit
    + delta.outputTokens / 1e6 * DEEPSEEK_CNY_PER_MTOK.output
  if (cost <= 0) return undefined
  const hitPct = delta.billedInput > 0 ? Math.round(delta.cacheRead / delta.billedInput * 100) : 0
  const cny = cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)
  return `💰 本轮 ¥${cny}（缓存命中 ${hitPct}%）`
}

// ---- tool-card visibility (collapsed / expanded / hidden) ----

/**
 * The three render states a tool card cycles through, mirroring the design of the
 * removed upstream `@deepseek-ai/dsh-tui` package (`ToolCardVisibility`):
 * - `collapsed` — show only a head/tail preview of the card body (default),
 * - `expanded`  — show the full body,
 * - `hidden`    — drop the card from the transcript entirely.
 */
export type ToolCardVisibility = 'hidden' | 'collapsed' | 'expanded'

/** The cycle order Ctrl+O walks: collapsed → expanded → hidden → back to collapsed. */
export const TOOL_CARD_CYCLE: readonly ToolCardVisibility[] = ['collapsed', 'expanded', 'hidden']

/** Human label for a visibility state (used in the status strip). */
export const TOOL_CARD_LABEL: Record<ToolCardVisibility, string> = {
  collapsed: '折叠',
  expanded: '展开',
  hidden: '隐藏',
}

/**
 * Next visibility in the Ctrl+O cycle; an unknown value cycles from `collapsed`.
 * @param current - the current state (or an invalid value).
 */
export function nextToolCardVisibility(current: string | undefined): ToolCardVisibility {
  const i = TOOL_CARD_CYCLE.indexOf(current as ToolCardVisibility)
  if (i < 0) return 'collapsed'
  // The cycle array is fixed at module scope and indexOf already validated the
  // value, so the increment always lands inside the array; no ?? fallback.
  return TOOL_CARD_CYCLE[(i + 1) % TOOL_CARD_CYCLE.length] as ToolCardVisibility
}

/**
 * The head/tail preview scale for a collapsed card: how many leading and trailing
 * body lines stay visible before the elision marker.
 */
export interface CollapseScale {
  head: number
  tail: number
}

/** Default collapse preview: 4 leading lines and 3 trailing lines. */
export const COLLAPSE_HEAD_LINES = 4
export const COLLAPSE_TAIL_LINES = 3

/**
 * Build the collapsed preview text for a card body. Keeps `scale.head` leading and
 * `scale.tail` trailing lines separated by one elision marker; short bodies (no more
 * than head+tail+1 lines) render in full without a marker. Pure string work so the
 * terminal glue only decides ANSI on the marker itself.
 * @param text - the full card body.
 * @param scale - head/tail line budget.
 * @returns the preview string, or `undefined` when the body needs no elision.
 */
export function collapseToolText(
  text: string,
  scale: CollapseScale = { head: COLLAPSE_HEAD_LINES, tail: COLLAPSE_TAIL_LINES },
): string | undefined {
  const lines = text.split('\n')
  // Trailing empty lines are an artifact of how results are appended; trim them
  // so the preview does not end on a blank line (and elision counts line properly).
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const { head, tail } = scale
  // No elision needed when everything fits within the head+tail budget (plus room
  // for exactly one elision marker line).
  if (lines.length <= head + tail + 1) return undefined
  const beforeNum = Math.max(0, head)
  const afterNum = Math.max(0, tail)
  const headLines = lines.slice(0, beforeNum)
  const tailLines = lines.slice(Math.max(0, lines.length - afterNum))
  return [...(headLines.length > 0 ? headLines : []), '\u2026', ...(tailLines.length > 0 ? tailLines : [])].join('\n')
}

/**
 * Lines of context kept between consecutive page scrolls so the reader never
 * loses their place at the page seam. Mirrors pi-tui's alt-screen paging.
 */
export const PAGE_SCROLL_OVERLAP_LINES = 4

/**
 * Decide what a raw input sequence means for the `[` / `]` transcript-paging
 * shortcut. The keys page up/down only while the editor draft is empty — an
 * empty input box signals reading intent; once any text exists the keys type
 * literally again, which is the built-in conflict fallback for text entry.
 * @param data - one raw terminal input sequence.
 * @param editorEmpty - whether the editor draft is currently empty.
 * @returns the scroll direction, or `undefined` when the sequence must fall
 * through to normal input handling.
 */
export function bracketScrollAction(data: string, editorEmpty: boolean): 'up' | 'down' | undefined {
  if (!editorEmpty || data.length !== 1) return undefined
  if (data === '[') return 'up'
  if (data === ']') return 'down'
  return undefined
}

/**
 * Resolve a `$VISUAL` / `$EDITOR` spec into an argv vector for opening the
 * draft in an external editor. GUI editors need flags ("subl -w", "code -w")
 * and spawn takes the executable separately from its arguments, so the spec
 * is split on whitespace; an empty or unset spec falls back to bare `vi`.
 * @param spec - the raw `$VISUAL ?? $EDITOR` value (may be empty/undefined).
 * @returns argv with the executable first, flags after — append the draft path last.
 */
export function editorCommandArgv(spec: string | undefined): [string, ...string[]] {
  const parts = (spec ?? '').trim().split(/\s+/).filter(part => part !== '')
  const executable = parts[0]
  if (executable === undefined) return ['vi']
  return [executable, ...parts.slice(1)]
}

/** CSI-u (kitty protocol) key sequence: ESC [ codepoint ; modifiers(:event-type) u. */
export const KITTY_CSI_U = /^\x1b\[(\d+);([\d:;]*)u$/

/**
 * Recognize Ctrl+G across every wire form the supported terminals produce:
 * the bare \x07 byte when no keyboard protocol is active, the bit-encoded
 * CSI-u / modifyOtherKeys forms pi-tui's matchesKey understands
 * (Ctrl = bit 4), and iTerm2's CSI-u form with modifier=9, which matchesKey
 * rejects — letting it through means the press falls into the input listener's
 * control-character mapping and the external editor never opens.
 * @param keyData - one decoded input sequence as delivered by the TUI input listener.
 * @returns whether this sequence is a Ctrl+G press (release events excluded).
 */
export function isCtrlG(keyData: string): boolean {
  if (matchesKey(keyData, 'ctrl+g') || keyData === '\x06') return true
  const csiU = KITTY_CSI_U.exec(keyData)
  return csiU !== null && Number(csiU[1]) === 103 && (csiU[2] ?? '').startsWith('9') && !isKeyRelease(keyData)
}

/** One model advertised by an OpenAI-compatible listing endpoint. */
export interface GatewayModelInfo {
  readonly id: string
  readonly ownedBy: string | undefined
  /** Whether the runtime config already declares this id on any route. */
  readonly configured: boolean
}

/** Default OpenCode gateway base (the completions route's endpoint). */
export const OPENCODE_MODELS_BASE_URL = 'https://opencode.ai/zen/go/v1'

/**
 * Fetch the gateway's live model listing and mark which ids the runtime
 * config already declares. Read-only: the reply is display candidates for
 * `/get_opencode_models`, never a catalog refresh — adding one still goes
 * through the config file + /reload.
 * @param options - endpoint, credential, injectable fetch, and the declared-id set.
 * @returns one row per advertised model, sorted unconfigured-first then by id.
 * @throws when the endpoint answers non-200 or the credential is missing.
 */
export async function fetchGatewayModels(options: {
  baseUrl?: string | undefined
  apiKey?: string | undefined
  fetchImpl?: typeof fetch
  declaredIds?: ReadonlySet<string>
}): Promise<GatewayModelInfo[]> {
  const { baseUrl = OPENCODE_MODELS_BASE_URL, apiKey, fetchImpl = fetch, declaredIds = new Set() } = options
  if (apiKey === undefined || apiKey === '') throw new Error('缺少凭证：OPENCODE_GO_API_KEY 未设置（检查 .env / launch-tui.sh）')
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!response.ok) throw new Error(`网关返回 ${String(response.status)} ${response.statusText}`)
  // OpenAI list shape: { object: "list", data: [{ id, owned_by? }, ...] }.
  const body = (await response.json()) as { data?: ReadonlyArray<{ id?: unknown; owned_by?: unknown }> }
  const rows = body.data ?? []
  const models: GatewayModelInfo[] = []
  for (const row of rows) {
    if (typeof row.id !== 'string' || row.id === '') continue
    models.push({
      id: row.id,
      ownedBy: typeof row.owned_by === 'string' ? row.owned_by : undefined,
      configured: declaredIds.has(row.id),
    })
  }
  return models.sort((left, right) => {
    if (left.configured !== right.configured) return left.configured ? 1 : -1 // unconfigured first
    return left.id.localeCompare(right.id)
  })
}

// ---- wb-proxy billing credits (tencent route) ----

/**
 * Fetch wb-proxy's billing multiplier per model id, normalized to a display
 * label: the raw multiplier ('x0.29'), or '免费' when the proxy marks the
 * model free (credits 'x0.00' or unreported). Ids absent from the map carry
 * no multiplier information. wb-proxy serves this list unauthenticated, and
 * any failure (proxy not running) resolves to an empty map — credits are
 * optional decoration, never a reason for the REPL to fail.
 * @param modelsUrl - the wb-proxy `/v1/models` endpoint.
 * @param fetchImpl - injectable fetch for tests.
 */
export async function fetchModelCredits(modelsUrl: string, fetchImpl: typeof fetch = fetch): Promise<Map<string, string>> {
  const labels = new Map<string, string>()
  try {
    const response = await fetchImpl(modelsUrl)
    if (!response.ok) return labels
    const body = (await response.json()) as { data?: ReadonlyArray<{ id?: unknown; workbuddy_credits?: unknown }> }
    for (const row of body.data ?? []) {
      if (typeof row.id !== 'string' || row.id === '') continue
      const credits = row.workbuddy_credits
      labels.set(row.id, typeof credits === 'string' && credits !== '' && credits !== 'x0.00' ? credits : '免费')
    }
  } catch {
    // proxy down: labels stay empty and the UI simply omits them
  }
  return labels
}
