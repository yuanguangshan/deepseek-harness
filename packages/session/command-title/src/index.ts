/**
 * Human-facing `/rename` command over the log-backed session-title service.
 * @module @deepseek-ai/dsh-command-title
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { SessionTitleInvalidError } from '@deepseek-ai/dsh-session-title'

export const name = 'command-title'
export const inject = ['commands', 'sessionTitle']

const USAGE = 'Usage: /rename <new title>'

/**
 * Execute one `/rename` invocation: accept the explicit user title, which the
 * title service pins against later automatic generation.
 */
async function executeRenameCommand(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const title = invocation.rawInput.trim()
  if (title === '') return { kind: 'error', text: USAGE }
  try {
    const snapshot = ctx.sessionTitle.rename(invocation.agent.session, title)
    return { kind: 'success', text: `Title set: ${snapshot.title}` }
  } catch (error: unknown) {
    if (error instanceof SessionTitleInvalidError) {
      return { kind: 'error', text: `${error.message}. ${USAGE}` }
    }
    throw error
  }
}

/** Register the `/rename` command for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'rename',
    description: 'rename the current session (pins the title; automatic generation stops)',
    input: { hint: '<new title>' },
    handler: invocation => executeRenameCommand(ctx, invocation),
  })
}
