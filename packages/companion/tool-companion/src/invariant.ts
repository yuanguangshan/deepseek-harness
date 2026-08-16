/**
 * Tool-companion invariant companion. The tools write host-side memory files
 * and read a host config/quota endpoints; neither produces a session event or
 * another authoritative stream this package owns.
 * @module @deepseek-ai/dsh-tool-companion/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-companion'

/** Cordis companion plugin name. */
export const name = 'tool-companion-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the tools' effects are host-side files and endpoint
 * queries, not an event stream or mutable runtime data this package owns; the
 * registration is intentionally empty.
 */
const install: InvariantInstaller = (_ctx: Context, _fail) => {}

/**
 * Register the tool-companion invariant companion (empty by design).
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
