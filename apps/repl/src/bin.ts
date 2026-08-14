#!/usr/bin/env node
/**
 * dsh-repl TUI entry. A thin dispatch to {@link runRepl}; the runtime argument
 * plumbing, widget glue, and subscription loop all live in ./tui-repl.ts.
 *
 * `--resume` requests an explicit start on the most recent historical session;
 * `--resume <id>` starts on that exact session; the REPL resumes the latest
 * session by default either way. `--cwd <dir>` binds the REPL to a different
 * workspace than the caller's current directory (used by the cross-workspace
 * `/resume` handoff to re-enter a session in the workspace it was created in).
 * @module @deepseek-ai/dsh-repl/bin
 */

/* v8 ignore file -- a self-executing entry exercised by manual and dev-mode launches. */

import { runRepl } from './tui-repl.ts'

const argv = process.argv.slice(2)

/** The value following `args[i]`, or undefined when absent or itself a flag. */
function nextValue(args: string[], i: number): string | undefined {
  const value = args[i + 1]
  return value !== undefined && !value.startsWith('--') ? value : undefined
}

const cwdIndex = argv.indexOf('--cwd')
const cwd = cwdIndex === -1 ? undefined : nextValue(argv, cwdIndex)
const resumeIndex = argv.indexOf('--resume')
// `--resume` alone means "resume the latest session"; `--resume <id>` a specific one.
const resume = resumeIndex === -1 ? undefined : (nextValue(argv, resumeIndex) ?? true)

void runRepl(
  resume !== undefined || cwd !== undefined
    ? { ...(resume !== undefined ? { resume } : {}), ...(cwd !== undefined ? { cwd } : {}) }
    : {},
)
