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
  // 0.1.3 起命令层按注册所在作用域归层：同步 apply 内的注册会落进插件子层，
  // 对普通 agent 不可见。改用 effect + yield 的规范注册（对齐 command-compact），
  // 注册落在根层，返回的 disposer 在插件卸载时（LIFO）自动反注册。
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'rename',
      description: 'rename the current session (pins the title; automatic generation stops)',
      input: { hint: '<new title>' },
      handler: invocation => executeRenameCommand(ctx, invocation),
    })
  })
}
