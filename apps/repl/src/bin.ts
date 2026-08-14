#!/usr/bin/env node
/**
 * dsh-repl TUI entry. A thin dispatch to {@link runRepl}; the runtime argument
 * plumbing, widget glue, and subscription loop all live in ./tui-repl.ts.
 *
 * `--resume` requests an explicit start on the most recent historical session;
 * the REPL resumes the latest session by default either way (see runRepl).
 * @module @deepseek-ai/dsh-repl/bin
 */

/* v8 ignore file -- a self-executing entry exercised by manual and dev-mode launches. */

import { runRepl } from './tui-repl.ts'

const resume = process.argv.includes('--resume')

void runRepl({ resume })
