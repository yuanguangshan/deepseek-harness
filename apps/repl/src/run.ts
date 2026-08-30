/**
 * Shared subprocess runner for the REPL's shell-out helpers (text2card, weixin).
 *
 * Collects stdout/stderr fully, optionally forwards complete stdout lines while
 * the child runs (streaming progress into the TUI status row), applies an
 * optional hard kill timeout, and never rejects — a spawn failure resolves as
 * `code: -1` with the error message on stderr so callers can render it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/** One finished subprocess run. */
export interface RunResult {
  /** Exit code, or -1 when the process could not be spawned. */
  readonly code: number
  /** Full stdout, including an unterminated final line. */
  readonly stdout: string
  /** Full stderr, or the spawn-error message when the child never ran. */
  readonly stderr: string
}

/** Options for one {@link runCommand} call. */
export interface RunOptions {
  /** Called with each complete stdout line (trimmed) while the child runs. */
  readonly onStdoutLine?: (line: string) => void
  /** Kill the child after this many ms; undefined runs without a deadline. */
  readonly timeoutMs?: number
  /** Working directory for the child (default: inherit the parent's). */
  readonly cwd?: string
}

/** Run `bin args…` to completion and resolve the collected output. */
export function runCommand(bin: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const { onStdoutLine, timeoutMs, cwd } = options
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    // stdio pipes 1 and 2 are non-null by construction; the array form only widens
    // the declared type, so narrow it once instead of optional-chaining every use.
    const pipes = child as unknown as ChildProcessWithoutNullStreams
    const out = pipes.stdout
    const errStream = pipes.stderr
    let stdout = ''
    let stderr = ''
    let lineBuf = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
      }, timeoutMs)
    }
    out.on('data', (chunk: Buffer) => {
      const text = String(chunk)
      stdout += text
      lineBuf += text
      const lines = lineBuf.split('\n')
      // split() always returns at least one element; the fallback is dead.
      // v8 ignore next -- split() never yields []
      lineBuf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed !== '') onStdoutLine?.(trimmed)
      }
    })
    errStream.on('data', (chunk: Buffer) => { stderr += String(chunk) })
    child.on('error', (error: Error) => {
      if (timer !== null) clearTimeout(timer)
      // A spawn failure emits no stderr; the close handler owns real stderr.
      resolve({ code: -1, stdout, stderr: error.message })
    })
    child.on('close', (code) => {
      if (timer !== null) clearTimeout(timer)
      const tail = lineBuf.trim()
      if (tail !== '') onStdoutLine?.(tail)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}
