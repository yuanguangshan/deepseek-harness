/** 本机 dsh 服务面板：状态卡、重启、日志、带 token 的访问地址。 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  SysadminLogsResult,
  SysadminSnapshot,
  SysadminTargetId,
  SysadminUrlsResult,
} from '../types.ts'
import type { SysadminInjected } from './api.ts'
import type { SysadminLocaleKey } from './locales.ts'
import css from './SysadminSection.module.css'

/** Full component props assembled by the Settings slot renderer. */
export type SysadminSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.sysadmin'>
  & InjectFace<SysadminInjected>


const TARGET_LABEL_KEYS = {
  'web-official': 'webOfficial',
  'web-dev': 'webDev',
  'wechat-proxy': 'wechatProxy',
} as const satisfies Record<SysadminTargetId, SysadminLocaleKey>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly snapshot: SysadminSnapshot }

export function SysadminSection({ t, status, restart, logs, urls }: SysadminSectionProps): ReactNode {
  const [view, setView] = useState<ViewState>({ status: 'loading' })
  const [updated, setUpdated] = useState<Date | undefined>(undefined)
  const [busy, setBusy] = useState<SysadminTargetId | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [logOpen, setLogOpen] = useState<SysadminTargetId | undefined>(undefined)
  const [logState, setLogState] = useState<{
    readonly loading: boolean
    readonly data: SysadminLogsResult | undefined
  }>({ loading: false, data: undefined })
  const [urlList, setUrlList] = useState<SysadminUrlsResult['entries'] | undefined>(undefined)
  const [confirmTarget, setConfirmTarget] = useState<SysadminTargetId | undefined>(undefined)
  const [copiedId, setCopiedId] = useState<string | undefined>(undefined)

  // One visible "copied" mark at a time; clears itself shortly after.
  const copyText = useCallback(async (text: string, id: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      setTimeout(() => { setCopiedId(current => (current === id ? undefined : current)) }, 1_500)
    } catch {
      setCopiedId(id)
    }
  }, [])

  // The arming window: a second click on the armed target fires the restart.
  useEffect(() => {
    if (confirmTarget === undefined) return
    const timer = setTimeout(() => { setConfirmTarget(undefined) }, 3_000)
    return () => { clearTimeout(timer) }
  }, [confirmTarget])

  const tokenKeys = useMemo(() => {
    const seen = new Map<SysadminTargetId, string>()
    for (const entry of urlList ?? []) {
      if (entry.token !== undefined && !seen.has(entry.target)) seen.set(entry.target, entry.token)
    }
    return [...seen.entries()].map(([target, token]) => ({ target, token }))
  }, [urlList])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const snapshot = await status()
      setView({ status: 'ready', snapshot })
      setUpdated(new Date())
    } catch (error) {
      setView({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [status])

  useEffect(() => {
    void refresh()
    void urls().then((result) => { setUrlList(result.entries) }).catch(() => { setUrlList([]) })
    const timer = setInterval(() => { void refresh() }, 10_000)
    return () => { clearInterval(timer) }
  }, [refresh, urls])

  const toggleLogs = useCallback(async (target: SysadminTargetId): Promise<void> => {
    if (logOpen === target) {
      setLogOpen(undefined)
      return
    }
    setLogOpen(target)
    setLogState({ loading: true, data: undefined })
    try {
      const data = await logs(target)
      if (data.target === target) setLogState({ loading: false, data })
    } catch {
      setLogState({ loading: false, data: undefined })
    }
  }, [logOpen, logs])

  const doRestart = useCallback(async (target: SysadminTargetId): Promise<void> => {
    // Two-step in-panel confirm: arm, then fire within the arming window.
    if (confirmTarget !== target) {
      setConfirmTarget(target)
      setNotice(undefined)
      return
    }
    setConfirmTarget(undefined)
    setBusy(target)
    setNotice(undefined)
    try {
      const result = await restart(target)
      setNotice(result.message)
      if (target === 'web-dev') {
        // This very host goes away; reload after it comes back.
        setTimeout(() => { window.location.reload() }, 6_000)
      } else {
        setTimeout(() => {
          setBusy(undefined)
          void refresh()
        }, 2_500)
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
      setBusy(undefined)
    }
  }, [confirmTarget, refresh, restart, t])

  const heading = <div className={css.heading}>{t('heading')}</div>

  if (view.status === 'loading') {
    return (
      <div>
        {heading}
        <div className={css.hint}>{t('logsLoading')}</div>
      </div>
    )
  }
  if (view.status === 'error') {
    return (
      <div>
        {heading}
        <div className={css.error}>{t('fetchError')}：{view.message}</div>
      </div>
    )
  }

  return (
    <div>
      <div className={css.headerRow}>
        {heading}
        <span className={css.hint}>{t('autoRefresh')}</span>
        <span className={css.hint}>
          {updated !== undefined ? `${t('updatedAt')} ${updated.toLocaleTimeString()}` : ''}
        </span>
      </div>

      {notice !== undefined && <div className={css.notice}>{notice}</div>}

      {view.snapshot.services.map((service) => {
        const label = t(TARGET_LABEL_KEYS[service.id])
        const restarting = busy === service.id
        return (
          <div key={service.id} className={css.card}>
            <div className={css.cardHeader}>
              <span className={`${css.dot} ${service.running ? css.dotOn : css.dotOff}`} />
              <span className={css.name}>{label}</span>
              <span className={css.stateText}>{service.running ? t('running') : t('stopped')}</span>
              <span className={css.spacer} />
              <button
                type="button"
                className={`${css.btn} ${confirmTarget === service.id ? css.danger : ''}`}
                disabled={busy !== undefined}
                onClick={() => { void doRestart(service.id) }}
              >
                {restarting
                  ? t('restarting')
                  : confirmTarget === service.id ? t('confirmRestart') : t('restart')}
              </button>
              <button
                type="button"
                className={css.btn}
                disabled={!service.running}
                onClick={() => { void toggleLogs(service.id) }}
              >
                {logOpen === service.id ? `${t('logs')} ×` : t('logs')}
              </button>
            </div>

            <div className={css.kvGrid}>
              <span className={css.kvKey}>{t('port')}</span><span>{service.port}</span>
              {service.pid !== undefined && (
                <>
                  <span className={css.kvKey}>{t('pid')}</span><span>{service.pid}</span>
                </>
              )}
              {service.uptime !== undefined && (
                <>
                  <span className={css.kvKey}>{t('uptime')}</span><span>{service.uptime}</span>
                </>
              )}
              {service.version !== undefined && (
                <>
                  <span className={css.kvKey}>{t('version')}</span><span>{service.version}</span>
                </>
              )}
              {service.detail !== undefined && (
                <>
                  <span className={css.kvKey}>{t('detail')}</span><span>{service.detail}</span>
                </>
              )}
              <span className={css.kvKey}>{t('source')}</span><span>{service.command ?? '—'}</span>
            </div>

            {logOpen === service.id && (
              <div>
                <div className={css.logBox}>
                  {logState.loading
                    ? t('logsLoading')
                    : (logState.data !== undefined && logState.data.lines.length > 0
                      ? logState.data.lines.join('\n')
                      : t('logsEmpty'))}
                </div>
                {logState.data !== undefined && <div className={css.logPath}>{logState.data.path}</div>}
              </div>
            )}
          </div>
        )
      })}

      <div className={css.card}>
        <div className={css.cardHeader}>
          <span className={css.name}>{t('webUrls')}</span>
        </div>
        {(urlList ?? []).map((entry) => {
          const copyId = `url:${entry.target}:${entry.label}`
          return (
            <div key={copyId} className={css.urlRow}>
              <span className={css.kvKey}>{t(TARGET_LABEL_KEYS[entry.target])} · {entry.label}</span>
              <span className={css.spacer} />
              <button type="button" className={css.btn} onClick={() => { void copyText(entry.url, copyId) }}>
                {copiedId === copyId ? t('copied') : t('copy')}
              </button>
              {entry.url.startsWith('https') && (
                <button type="button" className={css.btn} onClick={() => { window.open(entry.url, '_blank') }}>
                  {t('open')}
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div className={css.card}>
        <div className={css.cardHeader}>
          <span className={css.name}>{t('tokenKeys')}</span>
        </div>
        {tokenKeys.map(row => (
          <div key={`key:${row.target}`} className={css.urlRow}>
            <span className={css.kvKey}>{t(TARGET_LABEL_KEYS[row.target])}</span>
            <span className={css.urlText}>{row.token}</span>
            <button type="button" className={css.btn} onClick={() => { void copyText(row.token, `key:${row.target}`) }}>
              {copiedId === `key:${row.target}` ? t('copied') : t('copy')}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
