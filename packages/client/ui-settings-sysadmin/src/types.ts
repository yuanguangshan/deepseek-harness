/** Wire payloads mirrored from @deepseek-ai/dsh-host-sysadmin/src/types.ts. */

/** One administrated local service. Ids are stable API surface. */
export type SysadminTargetId = 'web-official' | 'web-dev' | 'wechat-proxy'

/** Live facts for one service, probed on demand. */
export interface SysadminServiceStatus {
  readonly id: SysadminTargetId
  readonly port: number
  readonly running: boolean
  readonly pid: number | undefined
  readonly uptime: string | undefined
  readonly command: string | undefined
  readonly version: string | undefined
  readonly detail: string | undefined
}

export interface SysadminSnapshot {
  readonly generatedAt: number
  readonly services: readonly SysadminServiceStatus[]
}

export interface SysadminRestartResult {
  readonly target: SysadminTargetId
  readonly triggered: boolean
  readonly message: string
}

export interface SysadminLogsResult {
  readonly target: SysadminTargetId
  readonly path: string
  readonly lines: readonly string[]
}

export interface SysadminUrlEntry {
  readonly target: SysadminTargetId
  /** Distinguishes parallel faces of one target, e.g. `本机` vs a tunnel domain. */
  readonly label: string
  readonly url: string
}

export interface SysadminUrlsResult {
  readonly entries: readonly SysadminUrlEntry[]
}
