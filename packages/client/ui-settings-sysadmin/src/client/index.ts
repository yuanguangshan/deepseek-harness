/** 系统管理 settings section: registers dictionaries, nav entry, and panel. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the Context.slots augmentation the registration below reads.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSysadminApi } from './api.ts'
import { SysadminSection } from './SysadminSection.tsx'
import { en, zh, type SysadminLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Local services admin copy. */
    'settings.sysadmin': SysadminLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.sysadmin'

/** Services required by the Settings registration. */
export const inject = ['slots', 'locale']

/** Contribute the top-level 系统管理 section to Web Settings. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-sysadmin: dictionaries')

  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'sysadmin',
    order: 90,
    label: () => t('nav'),
    locale: NS,
    inject: createSysadminApi,
  }, SysadminSection))
}
