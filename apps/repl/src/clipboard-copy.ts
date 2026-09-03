/**
 * Clipboard text write for `/copy` (+ Ctrl+Y): put the last assistant reply
 * (or its first code block) onto the OS clipboard. Platform dispatch follows
 * the same shell-out pattern as `clipboard-image.ts` — one command per
 * platform, payload passed through argv/stdin (never shell interpolation):
 * macOS `pbcopy`, Linux `xclip -selection clipboard` (X11) or `wl-copy`
 * (Wayland), Windows `clip.exe`. Payload routing per platform:
 * pbcopy/xclip/clip read stdin, wl-copy takes argv.
 * @module @deepseek-ai/dsh-repl/clipboard-copy
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { RunResult } from './run.ts'

/** Outcome of one clipboard write. */
export interface ClipboardCopyResult {
  ok: boolean
  /** Human-readable failure reason when not `ok`. */
  error?: string
}

/** Map a runner outcome to a result; exported for tests. */
export function interpretCopyOutcome(result: RunResult): ClipboardCopyResult {
  if (result.code === 0) return { ok: true }
  // A spawn failure reports on stderr with code -1; a real tool failure may
  // also write stderr — either way its message is the user-facing reason.
  const detail = result.stderr.trim()
  return { ok: false, error: detail !== '' ? detail.slice(0, 200) : `剪贴板写入失败（退出码 ${result.code}）` }
}

/**
 * Platform command for one copy attempt, or `undefined` when the platform is
 * unsupported. `args` builds the argv; `viaArgv` routes the payload (wl-copy
 * takes it as an argument, the rest read stdin).
 */
export interface CopyCommand {
  readonly bin: string
  readonly args: readonly string[]
  readonly viaArgv: boolean
}

/**
 * Resolve the clipboard-write command for the current platform. Linux checks
 * `WAYLAND_DISPLAY`/`XDG_SESSION_TYPE` for Wayland before falling back to
 * X11; `PATH` lookup is injectable so tests can pin each branch.
 */
export function resolveCopyCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  onPath: (bin: string) => boolean = defaultOnPath,
): CopyCommand | undefined {
  if (platform === 'darwin') return { bin: 'pbcopy', args: [], viaArgv: false }
  if (platform === 'win32') return { bin: 'clip.exe', args: [], viaArgv: false }
  if (platform === 'linux') {
    const isWayland = (env.WAYLAND_DISPLAY !== undefined && env.WAYLAND_DISPLAY !== '')
      || env.XDG_SESSION_TYPE === 'wayland'
    if (isWayland && onPath('wl-copy')) return { bin: 'wl-copy', args: [], viaArgv: true }
    if (onPath('xclip')) return { bin: 'xclip', args: ['-selection', 'clipboard'], viaArgv: false }
    // Wayland without wl-copy but with an X11 bridge still often works via xclip.
    if (onPath('wl-copy')) return { bin: 'wl-copy', args: [], viaArgv: true }
    return undefined
  }
  return undefined
}

/** PATH membership probe (no filesystem hit on absolute paths). */
function defaultOnPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean)
  return dirs.some(dir => existsSync(`${dir}/${bin}`))
}

/**
 * Write `text` to the system clipboard. Resolves `{ ok: false }` with a
 * user-facing reason on any failure — never throws.
 */
export async function copyTextToClipboard(
  text: string,
  runner: CopyRunner = defaultRunner,
  resolve: (
    platform?: NodeJS.Platform,
    env?: NodeJS.ProcessEnv,
    onPath?: (bin: string) => boolean,
  ) => CopyCommand | undefined = resolveCopyCommand,
): Promise<ClipboardCopyResult> {
  const command = resolve()
  if (command === undefined) {
    return { ok: false, error: `暂不支持平台 ${process.platform} 的剪贴板写入` }
  }
  try {
    return interpretCopyOutcome(await runner(command, text))
  } catch (error) {
    return { ok: false, error: `剪贴板写入失败: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** One resolved platform copy attempt executed against `payload`. */
export type CopyRunner = (command: CopyCommand, payload: string) => Promise<RunResult>

/** Real runner: spawn the tool, pipe stdin for stdin-readers, argv for wl-copy. */
export const defaultRunner: CopyRunner = (command, payload) => new Promise((resolve) => {
  const child = spawn(command.bin, [...command.args, ...(command.viaArgv ? [payload] : [])], {
    stdio: command.viaArgv ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => { stdout += String(chunk) })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += String(chunk) })
  child.on('error', (error: Error) => {
    resolve({ code: -1, stdout, stderr: error.message })
  })
  child.on('close', (code) => { resolve({ code: code ?? -1, stdout, stderr }) })
  if (!command.viaArgv) {
    child.stdin?.on('error', () => { /* EPIPE when the tool exits early; close owns the result */ })
    child.stdin?.end(payload, 'utf8')
  }
})
