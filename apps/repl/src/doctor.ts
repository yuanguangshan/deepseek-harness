/**
 * `/doctor`: one-shot environment health check. Each check is an independent
 * entry with a pure predicate over injectable probes (fs existence, PATH
 * membership, env vars), so the panel renders without spawning anything and
 * tests can force every branch. Live connectivity (API keys' remaining
 * balance) is deliberately NOT probed here — it belongs to the already
 * running usage refresh (`/context`、状态栏), and a network probe would make
 * this command slow and flaky.
 * @module @deepseek-ai/dsh-repl/doctor
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Severity of one check outcome. */
export type DoctorVerdict = 'ok' | 'warn' | 'fail'

/** One rendered check row. */
export interface DoctorCheck {
  /** Stable check name shown in the panel. */
  readonly name: string
  readonly verdict: DoctorVerdict
  /** Human-readable detail: what passed, or what to fix. */
  readonly detail: string
}

/** Probes the check predicates read; injectable for tests. */
export interface DoctorProbes {
  /** Whether a filesystem path exists. */
  readonly exists: (path: string) => boolean
  /** Whether a bare command name resolves on PATH; defaults to `onPathDefault(bin, env)`. */
  readonly onPath?: (bin: string) => boolean
  /** Environment variables (defaults to `process.env`). */
  readonly env: NodeJS.ProcessEnv
  /** The platform (defaults to `process.platform`). */
  readonly platform?: NodeJS.Platform
}

/** Default probes over the real environment. */
export const defaultProbes = (): DoctorProbes => ({
  exists: existsSync,
  onPath: bin => (process.env.PATH ?? '').split(delimiter).filter(Boolean).some(dir => existsSync(join(dir, bin))),
  env: process.env,
  platform: process.platform,
})

/** PATH membership over `PATH`-style lists (the platform separator `delimiter` honors). */
export function onPathDefault(bin: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? '').split(delimiter).filter(Boolean).some(dir => existsSync(join(dir, bin)))
}

/** The wechat-send skill script the REPL's `/weixin` shells out to. */
export function wechatSendScriptPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.WECHAT_SEND_SCRIPT ?? join(homedir(), '.pi/agent/skills/wechat-send/scripts/send.py')
}

/** Run every check against the given probes. Order: core → workspace → extras. */
export function runDoctorChecks(probes: DoctorProbes = defaultProbes()): DoctorCheck[] {
  const { exists, env } = probes
  const platform = probes.platform ?? process.platform
  const onPath = probes.onPath ?? ((bin: string) => onPathDefault(bin, env))
  const checks: DoctorCheck[] = []

  // Runtime launch chain: REPL → runtime bin → cordis config.
  const runtimeBin = env.DSH_REPL_RUNTIME ?? ''
  if (runtimeBin !== '') {
    const isBare = !runtimeBin.includes('/') && !runtimeBin.includes('\\')
    checks.push(isBare || exists(runtimeBin)
      ? { name: '运行时入口', verdict: 'ok', detail: `DSH_REPL_RUNTIME=${runtimeBin}` }
      : { name: '运行时入口', verdict: 'fail', detail: `DSH_REPL_RUNTIME 指向的文件不存在: ${runtimeBin}` })
  } else {
    checks.push({ name: '运行时入口', verdict: 'warn', detail: 'DSH_REPL_RUNTIME 未设置，使用仓库内默认路径（独立安装场景必须设置）' })
  }
  const configPath = env.DSH_REPL_CONFIG ?? ''
  if (configPath !== '') {
    checks.push(exists(configPath)
      ? { name: '运行时配置', verdict: 'ok', detail: `DSH_REPL_CONFIG=${configPath}` }
      : { name: '运行时配置', verdict: 'fail', detail: `DSH_REPL_CONFIG 指向的文件不存在: ${configPath}` })
  } else {
    checks.push({ name: '运行时配置', verdict: 'warn', detail: 'DSH_REPL_CONFIG 未设置，使用仓库内示例配置' })
  }

  // Session store: the resume picker and history search need it readable.
  const sessionRoot = env.DSH_SESSION_ROOT ?? join(process.cwd(), '.sessions')
  checks.push(exists(sessionRoot)
    ? { name: '会话存储', verdict: 'ok', detail: sessionRoot }
    : { name: '会话存储', verdict: 'warn', detail: `${sessionRoot} 不存在（首个会话落盘后生成）` })

  // Workspace git: /diff, /revert, memory branch scoping.
  const gitOk = onPath('git')
  checks.push(gitOk
    ? { name: 'git 工具', verdict: 'ok', detail: 'git 在 PATH 上（/diff、/revert 可用）' }
    : { name: 'git 工具', verdict: 'warn', detail: 'git 不在 PATH 上，/diff 与 /revert 不可用' })

  // Clipboard: /copy + Ctrl+Y.
  if (platform === 'darwin') {
    checks.push(onPath('pbcopy')
      ? { name: '剪贴板写入', verdict: 'ok', detail: 'pbcopy 可用（/copy · Ctrl+Y）' }
      : { name: '剪贴板写入', verdict: 'fail', detail: 'pbcopy 不可用，/copy 无法工作' })
  } else if (platform === 'win32') {
    checks.push(onPath('clip.exe')
      ? { name: '剪贴板写入', verdict: 'ok', detail: 'clip.exe 可用（/copy · Ctrl+Y）' }
      : { name: '剪贴板写入', verdict: 'fail', detail: 'clip.exe 不可用，/copy 无法工作' })
  } else if (platform === 'linux') {
    const wayland = (env.WAYLAND_DISPLAY !== undefined && env.WAYLAND_DISPLAY !== '') || env.XDG_SESSION_TYPE === 'wayland'
    const wlCopy = onPath('wl-copy')
    const xclip = onPath('xclip')
    if (wayland && wlCopy) {
      checks.push({ name: '剪贴板写入', verdict: 'ok', detail: 'wl-copy 可用（Wayland）' })
    } else if (xclip) {
      checks.push({ name: '剪贴板写入', verdict: 'ok', detail: 'xclip 可用（X11）' })
    } else if (wlCopy) {
      checks.push({ name: '剪贴板写入', verdict: 'ok', detail: 'wl-copy 可用' })
    } else {
      checks.push({ name: '剪贴板写入', verdict: 'fail', detail: '需要 xclip（X11）或 wl-copy（Wayland）其一' })
    }
  } else {
    checks.push({ name: '剪贴板写入', verdict: 'warn', detail: `平台 ${platform} 暂无剪贴板支持` })
  }

  // TTS: player availability gates /tts (synthesis itself is bundled).
  const players = ['afplay', 'ffplay', 'paplay'].filter(p => onPath(p))
  checks.push(players.length > 0
    ? { name: 'TTS 播放器', verdict: 'ok', detail: `可用: ${players.join(' / ')}` }
    : { name: 'TTS 播放器', verdict: 'warn', detail: '未找到 afplay/ffplay/paplay，/tts 只能合成不能播放' })

  // WeChat push: script presence (credentials live inside the script's auth file).
  const sendScript = wechatSendScriptPath(env)
  checks.push(exists(sendScript)
    ? { name: '微信推送', verdict: 'ok', detail: sendScript }
    : { name: '微信推送', verdict: 'warn', detail: `脚本不存在: ${sendScript}（/weixin 不可用）` })

  // OpenCode gateway key: only powers /get_opencode_models.
  checks.push((env.OPENCODE_GO_API_KEY !== undefined && env.OPENCODE_GO_API_KEY !== '')
    ? { name: 'OpenCode 凭证', verdict: 'ok', detail: 'OPENCODE_GO_API_KEY 已设置' }
    : { name: 'OpenCode 凭证', verdict: 'warn', detail: 'OPENCODE_GO_API_KEY 未设置（仅影响 /get_opencode_models）' })

  return checks
}

const VERDICT_GLYPH: Record<DoctorVerdict, string> = { ok: '✓', warn: '⚠', fail: '✗' }
const VERDICT_COLOR: Record<DoctorVerdict, (s: string) => string> = {
  ok: s => `\x1b[32m${s}\x1b[0m`,
  warn: s => `\x1b[33m${s}\x1b[0m`,
  fail: s => `\x1b[31m${s}\x1b[0m`,
}

/** Render the doctor panel (plain function of the checks; style-injectable). */
export function formatDoctorReport(checks: readonly DoctorCheck[]): string {
  const glyph = (v: DoctorVerdict): string => VERDICT_COLOR[v](`${VERDICT_GLYPH[v]}`)
  const failures = checks.filter(c => c.verdict === 'fail').length
  const warnings = checks.filter(c => c.verdict === 'warn').length
  const head = failures === 0 && warnings === 0
    ? '🩺 环境自检：全部通过'
    : `🩺 环境自检：${failures} 项失败 · ${warnings} 项警告`
  return [head, ...checks.map(c => `  ${glyph(c.verdict)} ${c.name}  ${c.detail}`), '', '  网络/余额类检查见状态栏用量（本命令只查本地依赖）'].join('\n')
}
