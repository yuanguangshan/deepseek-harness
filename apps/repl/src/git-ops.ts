/**
 * Git working-tree operations for `/diff` and `/revert`: run `git diff` and
 * render its output with diff-aware coloring, and (behind the caller's
 * confirmation) discard unstaged modifications with `git checkout -- .`.
 * All git invocations run from the REPL workspace; a non-repo or a git
 * failure is a rendered result, never an exception.
 * @module @deepseek-ai/dsh-repl/git-ops
 */

import { exec } from 'node:child_process'

/** Default kill window; a diff can be slow on huge trees but not forever. */
export const GIT_TIMEOUT_MS = 30_000

/** One finished git run. */
export interface GitResult {
  ok: boolean
  stdout: string
  /** Exit code: 0 = clean/success, 1 = success-with-differences (`diff --quiet`), >1 = failure. */
  code: number
  /** Failure detail (spawn error or stderr) when not `ok`. */
  error?: string
}

/** One `git <args>` invocation resolved against a working directory. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>

/** Run one git command to completion; never throws. */
export function runGit(args: readonly string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve) => {
    exec(`git ${args.join(' ')}`, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      if (error !== null && error.killed === true) {
        resolve({ ok: false, stdout, code: -1, error: `git 超时（${Math.round(timeoutMs / 1000)}s）` })
        return
      }
      // Exit 1 from `git diff` legitimately means "differences found"; only
      // exit 128+ (or a spawn failure) is a failure of the git invocation.
      // The non-numeric arm covers spawn failures (ENOENT cwd → `error.code`
      // is the string 'ENOENT'), mapping them to -1.
      const code = error === null ? 0 : (typeof error.code === 'number' ? error.code : -1)
      if (code > 1 || code < 0) {
        resolve({ ok: false, stdout, code, error: stderr.trim() !== '' ? stderr.trim() : `git 退出码 ${code}` })
        return
      }
      resolve({ ok: true, stdout, code })
    })
  })
}

const ADDED = (s: string): string => `\x1b[32m${s}\x1b[0m`
const REMOVED = (s: string): string => `\x1b[31m${s}\x1b[0m`
const HUNK = (s: string): string => `\x1b[36m${s}\x1b[0m`
const META = (s: string): string => `\x1b[90m${s}\x1b[0m`

/** Cap on rendered diff characters (a huge diff is summarized, not dumped). */
export const DIFF_MAX_CHARS = 12_000

/**
 * Colorize unified-diff text: added lines green, removed lines red, hunk
 * headers cyan, file headers gray. Line-level only (no word diff) — the
 * renderer must stay trivially predictable.
 */
export function colorizeDiff(diffText: string): string {
  return diffText.split('\n').map((line) => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return META(line)
    if (line.startsWith('@@')) return HUNK(line)
    if (line.startsWith('+')) return ADDED(line)
    if (line.startsWith('-')) return REMOVED(line)
    return line
  }).join('\n')
}

/** The git invocation the composed operations call; tests override to inject failures. */
let gitRunner: GitRunner = runGit

/** Swap the git seam (test-only); returns the previous runner for restore. */
export function setGitRunner(runner: GitRunner): GitRunner {
  const previous = gitRunner
  gitRunner = runner
  return previous
}

/**
 * Run `git diff` (unstaged changes, the working tree against the index) and
 * return the TUI-ready output: empty tree → a short "干净" note; diff →
 * colorized head+tail elided at {@link DIFF_MAX_CHARS}; failure → the error.
 */
export async function workspaceDiff(cwd: string): Promise<string> {
  const status = await gitRunner(['--no-optional-locks', 'status', '--porcelain'], cwd)
  if (!status.ok) return META(`✗ 无法读取 git 状态: ${status.error}`)
  if (status.stdout.trim() === '') return '✓ 工作区干净（没有未提交改动）'
  const diff = await gitRunner(['--no-optional-locks', 'diff'], cwd)
  if (!diff.ok) return META(`✗ git diff 失败: ${diff.error}`)
  if (diff.stdout.trim() === '') return '✓ 没有未暂存的改动（改动已全部暂存或仅新增文件；新增文件用 git add 跟踪）'
  const body = diff.stdout.length > DIFF_MAX_CHARS
    ? `${colorizeDiff(diff.stdout.slice(0, DIFF_MAX_CHARS))}\n${META('…（diff 过长，已截断，完整输出用 !git diff 查看）')}`
    : colorizeDiff(diff.stdout)
  return body
}

/**
 * Discard ALL unstaged modifications (`git checkout -- .`) after re-checking
 * the working tree still has unstaged content. Returns the TUI-ready result
 * line. The caller owns the human confirmation; this function is the
 * irreversible step and refuses to run against a tree git cannot read.
 */
export async function revertUnstaged(cwd: string): Promise<string> {
  // `git diff --quiet` exits 0 with NO unstaged changes and 1 with some.
  const check = await gitRunner(['--no-optional-locks', 'diff', '--quiet'], cwd)
  if (!check.ok) return META(`✗ 无法读取 git 状态: ${check.error}`)
  if (check.code === 0) return '✓ 没有未暂存的改动，无需撤销'
  const revert = await gitRunner(['checkout', '--', '.'], cwd)
  if (!revert.ok) return META(`✗ 撤销失败: ${revert.error}`)
  return '✓ 已撤销全部未暂存的改动（git checkout -- .）'
}
