/**
 * Turn-completion notifications: when a turn runs long enough that the user
 * likely switched away, fire a macOS notification-center toast (and optionally
 * a WeChat push via the existing `/weixin` channel). The decision is a pure
 * function; the sender is a thin `osascript` shell-out.
 * @module @deepseek-ai/dsh-repl/notify
 */

import { runCommand, type RunResult } from './run.ts'

/** Minimum turn duration before a notification fires (default 30s). */
export const DEFAULT_NOTIFY_MIN_MS = 30_000

/** Why a notification did or did not fire. */
export interface NotifyDecision {
  notify: boolean
  /** `ok` · `disabled` (DSH_REPL_NOTIFY=off) · `too-short` · `not-darwin`. */
  reason: string
}

/**
 * Decide whether a finished turn should notify. `DSH_REPL_NOTIFY=off` opts
 * out entirely; the duration gate keeps short replies from spamming toasts.
 */
export function shouldNotifyTurnComplete(
  durationMs: number,
  opts: { minMs?: number; enabled?: boolean; platform?: NodeJS.Platform } = {},
): NotifyDecision {
  const enabled = opts.enabled ?? process.env.DSH_REPL_NOTIFY !== 'off'
  if (!enabled) return { notify: false, reason: 'disabled' }
  const platform = opts.platform ?? process.platform
  if (platform !== 'darwin') return { notify: false, reason: 'not-darwin' }
  const minMs = opts.minMs ?? DEFAULT_NOTIFY_MIN_MS
  if (durationMs < minMs) return { notify: false, reason: 'too-short' }
  return { notify: true, reason: 'ok' }
}

/** Escape a string for safe inclusion inside an AppleScript double-quoted literal. */
export function escapeAppleScriptString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Post one notification-center toast. Never throws — a spawn failure or
 * non-zero exit resolves `false` so callers can fire-and-forget.
 */
export async function sendSystemNotification(
  title: string,
  body: string,
  runner: typeof runCommand = runCommand,
): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  const script = `display notification "${escapeAppleScriptString(body)}" with title "${escapeAppleScriptString(title)}" sound name "Glass"`
  const result: RunResult = await runner('osascript', ['-e', script])
  return result.code === 0
}
