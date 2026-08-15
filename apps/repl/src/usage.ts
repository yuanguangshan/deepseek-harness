/**
 * API usage/quota status for the REPL status bar.
 *
 * Reads credentials from `~/.zcode/v2/config.json` (override with `DSH_REPL_ZCODE_CONFIG`) and
 * queries the same two endpoints as the OpenCode/DeepSeek usage skills:
 *
 *   * opencode go  — `GET {baseURL}/usage`     → three rolling-window usage percentages
 *   * DeepSeek 官方 — `GET {baseURL}/user/balance` → total balance (CNY)
 *
 * The pure parsing/formatting lives here (unit-tested to 100%) while the terminal glue in the
 * TUI stays thin and coverage-excluded. The HTTP `fetchImpl` is injectable for tests.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The provider kinds this module can query. */
export type QuotaKind = 'opencode' | 'deepseek'

/** A quota-queryable provider discovered in the ZCode config. */
export interface QuotaProvider {
  readonly kind: QuotaKind
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly apiKey: string
}

/** One opencode go rolling window (rolling / weekly / monthly). */
export interface OpenCodeWindow {
  readonly status: string
  readonly percent: number
  readonly resetsAt: string
}

export type OpenCodeWindowName = 'rolling' | 'weekly' | 'monthly'

/** The aggregated quota picture displayed in the status bar. */
export interface UsageSnapshot {
  fetchedAt: number
  opencodeName?: string
  opencode?: Partial<Record<OpenCodeWindowName, OpenCodeWindow>>
  deepseekName?: string
  deepseekBalanceCny?: number
  deepseekAvailable?: boolean
}

/** Default ZCode config path (override with DSH_REPL_ZCODE_CONFIG). */
export function usageConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DSH_REPL_ZCODE_CONFIG
  if (override !== undefined && override.trim() !== '') return override
  return join(homedir(), '.zcode', 'v2', 'config.json')
}

/** Parse the ZCode config text into quota-queryable providers (malformed input → []). */
export function loadUsageProviders(configText: string): QuotaProvider[] {
  let doc: unknown
  try {
    doc = JSON.parse(configText)
  } catch {
    return []
  }
  const docObj = doc as { provider?: unknown } | null
  const providersRaw = docObj !== null && typeof docObj === 'object' && !Array.isArray(docObj) ? docObj.provider : undefined
  if (typeof providersRaw !== 'object' || providersRaw === null || Array.isArray(providersRaw)) return []
  const out: QuotaProvider[] = []
  for (const [id, pv] of Object.entries(providersRaw as Record<string, unknown>)) {
    if (pv === null || typeof pv !== 'object' || Array.isArray(pv)) continue
    const provider = pv as { name?: unknown; options?: unknown }
    const options = (provider.options ?? {}) as Record<string, unknown>
    const base = typeof options.baseURL === 'string' ? options.baseURL : ''
    const key = typeof options.apiKey === 'string' ? options.apiKey : ''
    if (key === '') continue
    const name = typeof provider.name === 'string' && provider.name !== '' ? provider.name : id
    if (base.includes('opencode.ai')) out.push({ kind: 'opencode', id, name, baseUrl: base, apiKey: key })
    else if (base.includes('deepseek.com')) out.push({ kind: 'deepseek', id, name, baseUrl: base, apiKey: key })
  }
  return out
}

/**
 * Read + parse the ZCode config from disk. A missing/unreadable config yields `[]`
 * (the status bar just skips the quota segment rather than crashing the REPL).
 */
export function loadUsageProvidersFromDisk(path = usageConfigPath()): QuotaProvider[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return loadUsageProviders(text)
}

/** A `fetch`-compatible signature so tests can inject a stub. */
type HttpResponse = { ok: boolean; status: number; json(): Promise<unknown> }
export type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<HttpResponse>

const DEFAULT_FETCHER: Fetcher = (url, init) => globalThis.fetch(url, init)

/** Query BOTH provider kinds for a quota snapshot; a failed/absent query leaves that half empty. */
export async function fetchUsageSnapshot(
  providers: readonly QuotaProvider[],
  fetchImpl: Fetcher = DEFAULT_FETCHER,
  now: () => number = Date.now,
): Promise<UsageSnapshot> {
  const snapshot: UsageSnapshot = { fetchedAt: now() }
  const deepseek = providers.find(p => p.kind === 'deepseek')
  const opencode = providers.find(p => p.kind === 'opencode')
  if (deepseek !== undefined) {
    const ds = await fetchDeepseekBalance(deepseek, fetchImpl).catch(() => undefined)
    if (ds !== undefined) {
      snapshot.deepseekName = deepseek.name
      if (ds.is_available !== undefined) snapshot.deepseekAvailable = ds.is_available
      const first = ds.balance_infos?.find(b => typeof b.total_balance === 'number' || typeof b.total_balance === 'string')
      if (first !== undefined) {
        const balance = toNumber(first.total_balance)
        if (balance !== undefined) snapshot.deepseekBalanceCny = balance
      }
    }
  }
  if (opencode !== undefined) {
    const oc = await fetchOpenCodeUsage(opencode, fetchImpl).catch(() => undefined)
    if (oc !== undefined) {
      snapshot.opencodeName = opencode.name
      snapshot.opencode = parseOpenCodeUsage(oc)
    }
  }
  return snapshot
}

/** DeepSeek `/user/balance` response shape (the fields we read). */
interface DeepseekBalance {
  is_available?: boolean
  balance_infos?: ReadonlyArray<{ currency?: string; total_balance?: unknown }>
}

async function fetchDeepseekBalance(provider: QuotaProvider, fetchImpl: Fetcher): Promise<DeepseekBalance> {
  const res = await fetchImpl(`${provider.baseUrl.replace(/\/$/, '')}/user/balance`, auth(provider))
  return (await res.json()) as DeepseekBalance
}

/** A raw opencode go window payload (a window may legitimately be `null` in the API response). */
interface OpenCodeWindowInput {
  status?: string
  percent?: unknown
  resetsAt?: string
}

/** opencode go `/usage` response shape (the fields we read). */
interface OpenCodeUsage {
  usage?: Partial<Record<OpenCodeWindowName, OpenCodeWindowInput | null>>
}

async function fetchOpenCodeUsage(provider: QuotaProvider, fetchImpl: Fetcher): Promise<OpenCodeUsage> {
  const res = await fetchImpl(`${provider.baseUrl.replace(/\/$/, '')}/usage`, auth(provider))
  return (await res.json()) as OpenCodeUsage
}

function auth(provider: QuotaProvider): { headers: Record<string, string> } {
  return { headers: { Authorization: `Bearer ${provider.apiKey}` } }
}

/** Parse the opencode `/usage` payload into typed windows, skipping empty/malformed ones. */
function parseOpenCodeUsage(data: OpenCodeUsage): Partial<Record<OpenCodeWindowName, OpenCodeWindow>> {
  const usage = data.usage ?? {}
  const out: Partial<Record<OpenCodeWindowName, OpenCodeWindow>> = {}
  for (const name of ['rolling', 'weekly', 'monthly'] as const) {
    const window = usage[name]
    if (window === undefined || window === null) continue
    out[name] = {
      status: typeof window.status === 'string' ? window.status : '',
      percent: toNumber(window.percent) ?? 0,
      resetsAt: typeof window.resetsAt === 'string' ? window.resetsAt : '',
    }
  }
  return out
}

/** Coerce an unknown value to a number, or to undefined when it is not finite-numeric. */
function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isNaN(n) ? undefined : n
  }
  return undefined
}

/** The opencode windows in display-priority order; missing ones are skipped. */
const OPCODE_WINDOWS: readonly OpenCodeWindowName[] = ['rolling', 'weekly', 'monthly']

/** Per-window tone threshold helpers (mirror the usage skills: 🟢<50 / 🟡50-79 / 🔴≥80). */
function toneOfPercent(percent: number): UsageTone {
  if (percent >= 80) return 'red'
  if (percent >= 50) return 'yellow'
  return 'green'
}

/** Tone chosen when a provider is present but the indicated data is missing/failed. */
const MISSING_TONE: UsageTone = 'gray'

export type UsageTone = 'green' | 'yellow' | 'red' | 'gray'

/** Style function set injected by the UI layer; default is no color. */
export interface UsageStyle {
  green: (s: string) => string
  yellow: (s: string) => string
  red: (s: string) => string
  gray: (s: string) => string
}

const noStyle = (s: string): string => s
const NO_STYLE: UsageStyle = { green: noStyle, yellow: noStyle, red: noStyle, gray: noStyle }

/** One rendered status-bar segment (unstyled text + tone for coloring). */
export interface UsageSegment {
  readonly text: string
  readonly tone: UsageTone
}

/**
 * Build the compact status-bar segments for a quota snapshot.
 * opencode shows all three window usages (`OC 1% 57% 35%`); DeepSeek its balance (`DS ¥21.4`).
 * Returns [] when neither provider produced data.
 */
export function usageSegments(snapshot: UsageSnapshot): UsageSegment[] {
  const segments: UsageSegment[] = []
  if (snapshot.opencode !== undefined) {
    segments.push(opencodeSegment(snapshot.opencode))
  }
  if (snapshot.deepseekBalanceCny !== undefined || snapshot.deepseekAvailable !== undefined) {
    segments.push(deepseekSegment(snapshot))
  }
  return segments
}

function opencodeSegment(usage: Partial<Record<OpenCodeWindowName, OpenCodeWindow>>): UsageSegment {
  // All three windows in display-priority order; a missing window reads as 0%.
  const shown = OPCODE_WINDOWS.map((window) => {
    const candidate = usage[window]
    return candidate === undefined ? 0 : Math.min(100, candidate.percent)
  })
  // No usable window at all → gray dash (same "nothing to show" treatment as before).
  if (shown.every(pct => pct <= 0)) {
    return { text: 'OC —', tone: MISSING_TONE }
  }
  const body = shown.map(pct => `${pct}%`).join(' ')
  const heat = Math.max(...shown)
  return { text: `OC ${body}`, tone: toneOfPercent(heat) }
}

function deepseekSegment(snapshot: UsageSnapshot): UsageSegment {
  const label = 'DS'
  if (snapshot.deepseekAvailable === false) {
    return { text: `${label} 余额不可用`, tone: 'red' }
  }
  const balance = snapshot.deepseekBalanceCny
  if (balance === undefined || balance <= 0) {
    return { text: `${label} 余额 —`, tone: MISSING_TONE }
  }
  const tone: UsageTone = balance < 5 ? 'red' : balance < 20 ? 'yellow' : 'green'
  return { text: `${label} ¥${formatCny(balance)}`, tone }
}

/** Format a CNY value compactly: two decimals below 100, integers rounded above. */
function formatCny(v: number): string {
  if (v >= 100) return String(Math.round(v))
  return String(Math.round(v * 100) / 100)
}

/**
 * Render the quota segments into a single status-bar string with injected styling
 * (joined by ` · ` separators), or '' when there is nothing to show.
 */
export function formatUsageStatus(snapshot: UsageSnapshot, st: UsageStyle = NO_STYLE): string {
  const segments = usageSegments(snapshot)
  if (segments.length === 0) return ''
  const styled: string[] = []
  for (const segment of segments) {
    styled.push(styleByTone(segment.tone, segment.text, st))
  }
  return styled.join(` ${st.gray('·')} `)
}

function styleByTone(tone: UsageTone, text: string, st: UsageStyle): string {
  switch (tone) {
    case 'green': return st.green(text)
    case 'yellow': return st.yellow(text)
    case 'red': return st.red(text)
    default: return st.gray(text)
  }
}
