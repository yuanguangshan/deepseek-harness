/**
 * `!` bang commands: run a local shell command straight from the REPL prompt
 * (`!git status`) without anything reaching the model conversation. Parsing
 * and rendering live here so tests cover the pure logic; tui-repl only wires
 * the submit gate. Execution is shell-interpreted (pipes/redirections work)
 * and resolves on non-zero exits too — a failed command is a result, not an
 * exception.
 * @module @deepseek-ai/dsh-repl/bang
 */

import { exec } from 'node:child_process'

/** Default kill window; bang runs are quick lookups, not long jobs. */
export const BANG_DEFAULT_TIMEOUT_MS = 120_000

export type BangParse =
  | { kind: 'run'; command: string }
  | { kind: 'usage' }

/**
 * `!ls -la` → run 'ls -la'; bare `!` → usage hint; anything else → undefined
 * (not a bang, left for the normal submit path).
 */
export function parseBangCommand(text: string): BangParse | undefined {
  if (!text.startsWith('!')) return undefined
  const command = text.slice(1).trim()
  return command === '' ? { kind: 'usage' } : { kind: 'run', command }
}

export interface BangResult {
  command: string
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  durationMs: number
}

export interface BangOptions {
  timeoutMs?: number
  cwd?: string
}

export function runShellCommand(command: string, opts: BangOptions = {}): Promise<BangResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = exec(command, {
      timeout: opts.timeoutMs ?? BANG_DEFAULT_TIMEOUT_MS,
      cwd: opts.cwd,
      maxBuffer: 4 * 1024 * 1024,
      // SIGTERM can be swallowed by the shell wrapping the command; SIGKILL
      // guarantees the timeout actually stops the run.
      killSignal: 'SIGKILL',
    }, (error, stdout, stderr) => {
      resolve({
        command,
        stdout,
        stderr,
        code: child.exitCode,
        signal: child.signalCode,
        timedOut: error !== null && error.killed === true,
        durationMs: Date.now() - started,
      })
    })
  })
}

// ---- rendering ----

const gray = (s: string): string => `\x1b[90m${s}\x1b[0m`
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`

/** Transcript lines kept before/after the elided middle. */
export const BANG_MAX_LINES = 200
/** Hard character ceiling on top of the line cap (one long line can still be huge). */
const BANG_MAX_CHARS = 8_000

/**
 * Render a finished run for the transcript: `$ cmd` header, combined
 * stdout+stderr body (head+tail kept, middle elided), exit summary line.
 */
export function formatBangResult(r: BangResult, maxLines: number = BANG_MAX_LINES): string {
  const merged = (r.stdout + (r.stderr !== '' && r.stdout !== '' ? '\n' : '') + r.stderr).replace(/\n+$/, '')
  const lines = merged === '' ? [] : merged.split('\n')
  let body = merged
  if (lines.length > maxLines) {
    const half = Math.floor(maxLines / 2)
    const elided = lines.length - 2 * half
    body = [...lines.slice(0, half), gray(`…（中间省略 ${elided} 行）…`), ...lines.slice(-half)].join('\n')
  }
  if (body.length > BANG_MAX_CHARS) body = `${body.slice(0, BANG_MAX_CHARS)}${gray('…（输出过长已截断）')}`
  const seconds = (r.durationMs / 1000).toFixed(1)
  const tail = r.timedOut
    ? yellow(`⏱ 超时被终止（${seconds}s，可用 !'nohup … &' 跑长任务）`)
    : r.code === 0 && r.signal === null
      ? gray(`✓ 退出码 0 · ${seconds}s`)
      : red(`✗ 退出码 ${r.code ?? r.signal ?? '?'} · ${seconds}s`)
  return [gray(`$ ${r.command}`), body, tail].filter(part => part !== '').join('\n')
}

/** One-line usage hint shown for a bare `!`. */
export function formatBangUsage(): string {
  return gray('用法：! <shell 命令> — 本地直接执行（支持管道），输出只进会话记录、不发送给模型。例：!git status')
}
