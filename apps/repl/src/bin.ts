#!/usr/bin/env node
/**
 * dsh-repl TUI entry. A thin dispatch to {@link runRepl}; the runtime argument
 * plumbing, widget glue, and subscription loop live in ./tui-repl.ts, with the
 * status bar in ./status-bar.ts and the /text2card pipeline in ./text2card.ts.
 *
 * `--resume` requests an explicit start on the most recent historical session;
 * `--resume <id>` starts on that exact session; the REPL resumes the latest
 * session by default either way. `--cwd <dir>` binds the REPL to a different
 * workspace than the caller's current directory (used by the cross-workspace
 * `/resume` handoff to re-enter a session in the workspace it was created in).
 *
 * `--web-sessions` switches the REPL's on-disk session store to the same root
 * the `dsh web` profile uses (`<DSH_HOME>/sessions`, default `~/.dsh/sessions`)
 * so both front-ends read one shared log. It is an explicit override: it always
 * sets `DSH_SESSION_ROOT`, superseding any ambient value; without it the REPL
 * keeps its default per-workspace `./.sessions` behaviour.
 * @module @deepseek-ai/dsh-repl/bin
 */

/* v8 ignore file -- a self-executing entry exercised by manual and dev-mode launches. */

import { homedir } from 'node:os'
import { join } from 'node:path'

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
// `--web-sessions` flips the REPL onto the shared `dsh web` session store root.
// It wins over any ambient `DSH_SESSION_ROOT` (explicit flag, unconditional), so
// every path that resolves sessions (HarnessClient env, history.sessionRoot)
// agrees on one root for this run.
if (argv.includes('--web-sessions')) {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  process.env.DSH_SESSION_ROOT = join(dshHome, 'sessions')
  console.error(`[dsh-repl] --web-sessions: 会话根切换为 ${process.env.DSH_SESSION_ROOT}`)
}

void runRepl(
  resume !== undefined || cwd !== undefined
    ? { ...(resume !== undefined ? { resume } : {}), ...(cwd !== undefined ? { cwd } : {}) }
    : {},
)
