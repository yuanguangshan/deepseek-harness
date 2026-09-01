/**
 * Session-cost summary for the `/cost` command: turn/token aggregates already
 * tracked in {@link ReplStats} priced with the DeepSeek list prices shared with
 * the per-turn cost line. Pure and deterministic so it is unit-testable.
 * @module @deepseek-ai/dsh-repl/session-cost
 */

import { DEEPSEEK_CNY_PER_MTOK } from './core.ts'

/** Minimal stats subset the summary needs (satisfied by ReplStats). */
export interface SessionCostStats {
  billedInput: number
  outputTokens: number
  cacheRead: number
  turns: number
}

/** Compact integer token formatting: `12` / `1.2k` / `3.4M`. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

/** Yuan cost of one token bucket at list price. */
function costCny(billedInput: number, cacheRead: number, outputTokens: number): number {
  return billedInput / 1e6 * DEEPSEEK_CNY_PER_MTOK.inputCacheMiss
    + cacheRead / 1e6 * DEEPSEEK_CNY_PER_MTOK.inputCacheHit
    + outputTokens / 1e6 * DEEPSEEK_CNY_PER_MTOK.output
}

/** Render the `/cost` block: per-bucket tokens + list-price estimate for the whole session. */
export function formatSessionCost(stats: SessionCostStats): string {
  const cny = costCny(stats.billedInput, stats.cacheRead, stats.outputTokens)
  const total = stats.billedInput + stats.cacheRead + stats.outputTokens
  return [
    `💰 会话开销（${stats.turns} 轮 · 合计 ${fmtTokens(total)} tokens）`,
    `  计费输入 ${fmtTokens(stats.billedInput)} · 缓存命中 ${fmtTokens(stats.cacheRead)} · 输出 ${fmtTokens(stats.outputTokens)}`,
    `  按列表价估算 ¥${cny.toFixed(4)}（缓存未命中 ¥${DEEPSEEK_CNY_PER_MTOK.inputCacheMiss}/M · 命中 ¥${DEEPSEEK_CNY_PER_MTOK.inputCacheHit}/M · 输出 ¥${DEEPSEEK_CNY_PER_MTOK.output}/M）`,
  ].join('\n')
}
