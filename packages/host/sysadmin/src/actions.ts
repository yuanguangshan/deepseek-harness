/** Restart triggers, log tails, and web-token URL recovery for the panel. */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { LAUNCHD_LABELS, SERVICE_TABLE, WEB_DEV_SCRIPT, serviceSpec } from './services.ts'
import type { SysadminLogsResult, SysadminRestartResult, SysadminTargetId, SysadminUrlEntry, SysadminUrlsResult } from './types.ts'

const LAUNCHCTL = '/bin/launchctl'
const UID = process.getuid?.() ?? 501

/**
 * Trigger one service restart. For the dev web (this host, possibly) the kill
 * must land after the HTTP response — the restart runs in a detached shell on
 * a short delay so the panel gets its acknowledgement first.
 */
export async function triggerRestart(target: SysadminTargetId): Promise<SysadminRestartResult> {
  const label = LAUNCHD_LABELS[target]
  if (label !== undefined) {
    try {
      await run(LAUNCHCTL, ['kickstart', '-k', `gui/${UID}/${label}`], 8_000)
      return { target, triggered: true, message: `launchctl kickstart 已发送（${label}），KeepAlive 会自动拉起` }
    } catch (error) {
      return { target, triggered: false, message: `kickstart 失败：${errorText(error)}` }
    }
  }
  if (target === 'web-dev') {
    // Detached: survive this process (which may be the one being restarted).
    const child = spawn('/bin/bash', ['-c', `sleep 1; exec ${JSON.stringify(WEB_DEV_SCRIPT)} restart --force`], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    return {
      target,
      triggered: true,
      message: '重启已排队：3081 将在约 1 秒后重启，页面会短暂断开，数秒后刷新即可',
    }
  }
  return { target, triggered: false, message: '未知目标' }
}

function run(file: string, args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('timeout'))
    }, timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`exit ${code}`))
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Last `lines` lines of one service log; long lines are truncated. */
export async function tailLog(target: SysadminTargetId, lines: number): Promise<SysadminLogsResult> {
  const spec = serviceSpec(target)
  if (spec === undefined) throw new Error(`unknown target: ${String(target)}`)
  const bounded = Math.min(Math.max(Math.trunc(lines) || 60, 1), 300)
  let raw = ''
  try {
    raw = await readFile(spec.logPath, 'utf8')
  } catch {
    return { target, path: spec.logPath, lines: [`（日志不存在或不可读：${spec.logPath}）`] }
  }
  const all = raw.split('\n')
  if (all.length > 0 && all[all.length - 1] === '') all.pop()
  return {
    target,
    path: spec.logPath,
    lines: all.slice(-bounded).map(line => line.length > 500 ? `${line.slice(0, 500)}…` : line),
  }
}

const TOKEN_PATTERN = /\?token=[A-Za-z0-9_-]+/

/** Public tunnel face per web target (trusted hosts bound at boot). */
const TUNNEL_FACES: Partial<Record<SysadminTargetId, string>> = {
  'web-official': 'https://dsh.want.biz',
  'web-dev': 'https://dsh-dev.want.biz',
}

/** Latest tokened web URLs (local + tunnel faces) recovered from boot logs. */
export async function latestWebUrls(): Promise<SysadminUrlsResult> {
  const entries: SysadminUrlEntry[] = []
  for (const spec of SERVICE_TABLE) {
    if (spec.id === 'wechat-proxy') {
      entries.push({ target: spec.id, label: '本机', url: 'http://127.0.0.1:8490' })
      continue
    }
    let token: string | undefined
    try {
      const raw = await readFile(spec.logPath, 'utf8')
      const matches = raw.match(new RegExp(`dsh web: http://[^\\s]*${TOKEN_PATTERN.source}`, 'g'))
      token = matches?.[matches.length - 1]?.match(TOKEN_PATTERN)?.[0]?.slice('?token='.length)
    } catch {
      // log unreadable — fall through to the tokenless URLs below
    }
    entries.push({
      target: spec.id,
      label: '本机',
      url: token !== undefined
        ? `http://127.0.0.1:${spec.port}/?token=${token}`
        : `http://127.0.0.1:${spec.port}（日志里没有 token 行）`,
    })
    const tunnel = TUNNEL_FACES[spec.id]
    if (tunnel !== undefined) {
      entries.push({
        target: spec.id,
        label: tunnel.replace('https://', ''),
        url: token !== undefined ? `${tunnel}/?token=${token}` : `${tunnel}（缺 token，先从本机地址登录）`,
      })
    }
  }
  return { entries }
}

/** Home-relative display for log paths (kept for the UI subtitle). */
export function displayPath(path: string): string {
  return path.startsWith(homedir()) ? path.replace(homedir(), '~') : path
}
