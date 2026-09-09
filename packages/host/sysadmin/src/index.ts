/**
 * dsh-host-sysadmin — local services admin surface for the web panel.
 *
 * Registers four authenticated exact routes on the shared `/api` channel
 * (same trust fence as every other browser call): a status snapshot of the
 * machine's long-running dsh services, restart triggers, log tails, and the
 * latest tokened web URLs recovered from boot logs. Facts only — all labels
 * and presentation live in the client package.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { latestWebUrls, tailLog, triggerRestart } from './actions.ts'
import { createStatusSnapshot } from './probe.ts'
import { serviceSpec } from './services.ts'
import type { SysadminLogsResult, SysadminRestartResult, SysadminTargetId } from './types.ts'

export const name = 'sysadmin'
export const inject = ['connection']

/** Narrow an untrusted body/query value to a known target id. */
function parseTarget(value: unknown): SysadminTargetId | undefined {
  return typeof value === 'string' && serviceSpec(value as SysadminTargetId) !== undefined
    ? value as SysadminTargetId
    : undefined
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

/** One sysadmin route registration as an effect body. */
function route(
  ctx: Context,
  path: string,
  methods: readonly ('GET' | 'HEAD' | 'POST')[],
  handler: (request: Request) => Promise<Response>,
): () => Promise<void> {
  return ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch: handler })
}

/** Register the sysadmin routes; loaded via the profile bundle layer. */
export function apply(ctx: Context): void {
  ctx.effect(() => route(ctx, '/api/sysadmin/status', ['GET'], async () => {
    try {
      return json(await createStatusSnapshot())
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500)
    }
  }), 'sysadmin: status route')

  ctx.effect(() => route(ctx, '/api/sysadmin/restart', ['POST'], async (request) => {
    let target: SysadminTargetId | undefined
    try {
      const body = await request.json() as { target?: unknown }
      target = parseTarget(body.target)
    } catch {
      return json({ error: '请求体必须是 JSON' }, 400)
    }
    if (target === undefined) return json({ error: '未知目标' }, 400)
    const result: SysadminRestartResult = await triggerRestart(target)
    return json(result)
  }), 'sysadmin: restart route')

  ctx.effect(() => route(ctx, '/api/sysadmin/logs', ['GET'], async (request) => {
    const params = new URL(request.url).searchParams
    const target = parseTarget(params.get('target'))
    if (target === undefined) return json({ error: '未知目标' }, 400)
    const lines = Number.parseInt(params.get('lines') ?? '60', 10)
    const result: SysadminLogsResult = await tailLog(target, Number.isFinite(lines) ? lines : 60)
    return json(result)
  }), 'sysadmin: logs route')

  ctx.effect(() => route(ctx, '/api/sysadmin/urls', ['GET'], async () => {
    try {
      return json(await latestWebUrls())
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500)
    }
  }), 'sysadmin: urls route')
}
