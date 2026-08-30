/**
 * Weixin quick-send for the repl TUI.
 *
 * `/weixin` sends the last assistant reply (or some text) to WeChat, via the
 * shared `wechat-send` skill script but with WECLAW-first ordering (u 机
 * weclaw looks nicer in the user's conversation; 本机 weixinpush is the
 * fallback). Reuses the same skill that the agent itself uses, so credentials
 * and channel fallback stay in one place.
 *
 * This module only shells out to `send.py --weclaw-first`. We pass the payload
 * through the argv array (no shell interpolation), keeping content with
 * quotes/newlines/hashes safe.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { runCommand } from './run.ts'

/** The wechat-send skill script. Prefers the agent skill dir, falls back to the zcode copy. */
const SEND_SCRIPT = process.env.WECHAT_SEND_SCRIPT
  ?? (join(homedir(), '.pi/agent/skills/wechat-send/scripts/send.py'))
const PY = process.env.WECHAT_SEND_PY ?? 'python3'

/** Run send.py and resolve the human-readable result line for the TUI. */
async function runSend(args: string[]): Promise<{ ok: boolean; out: string }> {
  const { code, stdout, stderr } = await runCommand(PY, [SEND_SCRIPT, ...args], { timeoutMs: 30_000 })
  // Successful send prints `✅ 微信消息已发送 (channel=...)` on stdout.
  const ok = code === 0 && (/✅/.test(stdout) || stdout.trim() !== '')
  const out = stderr.trim() !== '' ? (stdout + stderr).trim() : stdout.trim()
  return code === -1 ? { ok: false, out: `无法调用 ${SEND_SCRIPT}: ${stderr.trim()}` } : { ok, out }
}

/**
 * Send `text` to WeChat with WECLAW-first ordering (u 机 weclaw → 本机
 * weixinpush fallback). Never throws; returns a TUI-displayable result string.
 */
export async function sendToWechat(text: string): Promise<string> {
  const trimmed = text.trim()
  if (trimmed === '') return '⚠️ 没有可发送的内容（空文本）'

  const { ok, out } = await runSend([trimmed, '--weclaw-first'])
  if (ok) {
    // Re-label with the actual channel for clarity without overriding the script's own message.
    return out.includes('(channel=') ? `📤 已发到微信：${out.split('(channel=')[1]}` : `📤 已发到微信 ${out}`
  }
  if (out === '') return '⚠️ 发送失败：脚本无输出（微信配额或通道不可用？）'
  return `⚠️ 发送失败：${out.slice(0, 200)}`
}
