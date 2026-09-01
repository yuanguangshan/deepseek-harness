/**
 * `/agents` panel: an in-REPL view of the runtime's background subagent runs.
 * The runtime reports `subagent.started` / `subagent.finished` notifications on
 * the session tree subscription the REPL already holds, so the panel state is
 * built by pure reductions over those notifications — no extra protocol.
 * @module @deepseek-ai/dsh-repl/agents-panel
 */

/** Raw notification params, narrowed to the fields the panel reads. */
export interface SubagentNotificationParams {
  parentSessionId?: unknown
  childSessionId?: unknown
  agentId?: unknown
  provider?: unknown
}

/** One observed background agent run. */
export interface AgentRunEntry {
  agentId: string
  parentSessionId?: string
  provider?: string
  startedAt: number
  endedAt?: number
}

/** The string form of a JSON-RPC notification params object, or undefined. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Fold one notification into the run list. `subagent.started` appends (or
 * re-marks) a run for the child id; `subagent.finished` stamps the end time and
 * provider on the matching open entry, creating one on sight for finished-first
 * delivery so the panel never loses the run.
 */
export function recordSubagentNotification(
  entries: readonly AgentRunEntry[],
  method: string,
  params: unknown,
  now: number,
): AgentRunEntry[] {
  if (params === null || typeof params !== 'object') return [...entries]
  const p = params as SubagentNotificationParams
  if (method === 'subagent.started') {
    const agentId = asString(p.childSessionId)
    if (agentId === undefined) return [...entries]
    const parentSessionId = asString(p.parentSessionId)
    const existing = entries.find(e => e.agentId === agentId && e.endedAt === undefined)
    if (existing !== undefined) {
      return entries.map(e => e === existing
        ? { ...e, startedAt: now, ...(parentSessionId === undefined ? {} : { parentSessionId }) }
        : e)
    }
    return [...entries, { agentId, startedAt: now, ...(parentSessionId === undefined ? {} : { parentSessionId }) }]
  }
  if (method === 'subagent.finished') {
    const agentId = asString(p.agentId) ?? asString(p.childSessionId)
    if (agentId === undefined) return [...entries]
    const provider = asString(p.provider)
    const open = [...entries].reverse().find(e => e.agentId === agentId && e.endedAt === undefined)
    if (open === undefined) {
      return [...entries, { agentId, startedAt: now, endedAt: now, ...(provider === undefined ? {} : { provider }) }]
    }
    return entries.map(e => e === open
      ? { ...e, endedAt: now, ...(provider === undefined || e.provider !== undefined ? {} : { provider }) }
      : e)
  }
  return [...entries]
}

/** Human duration like `850ms` / `12.3s` / `4m02s`. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1_000)
  return `${m}m${String(s).padStart(2, '0')}s`
}

/** Render the panel; newest run first, live runs marked. */
export function formatAgentsPanel(entries: readonly AgentRunEntry[], now: number): string {
  if (entries.length === 0) {
    return '当前没有后台代理记录。代理会话（subagent）启动后会出现在这里。'
  }
  const lines = [`🤖 后台代理（${entries.length} 次运行，最新在上）:`]
  for (const entry of [...entries].reverse()) {
    const live = entry.endedAt === undefined
    const dur = live ? formatDuration(now - entry.startedAt) : formatDuration((entry.endedAt ?? now) - entry.startedAt)
    const provider = entry.provider === undefined ? '' : ` · ${entry.provider}`
    const id = entry.agentId.length > 14 ? `${entry.agentId.slice(0, 14)}…` : entry.agentId
    lines.push(`  ${live ? '● 运行中' : '✓ 完成'}  ${id}  ${dur}${provider}`)
  }
  return lines.join('\n')
}
