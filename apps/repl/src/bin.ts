#!/usr/bin/env node
/**
 * dsh-repl TUI entry. A thin dispatch to {@link runRepl}; the runtime argument
 * plumbing, widget glue, and subscription loop all live in ./tui-repl.ts.
 * @module @deepseek-ai/dsh-repl/bin
 */

/* v8 ignore file -- a self-executing entry exercised by manual and dev-mode launches. */

import { runRepl } from './tui-repl.ts'

void runRepl()
