/** Wire payloads shared by the sysadmin HTTP surface (JSON over /api). */

/** One administrated local service. Ids are stable API surface. */
export type SysadminTargetId = 'web-official' | 'web-dev' | 'wechat-proxy'

/** Live facts for one service, probed on demand. */
export interface SysadminServiceStatus {
  readonly id: SysadminTargetId
  readonly port: number
  readonly running: boolean
  readonly pid: number | undefined
  /** Human `ps` etime, e.g. `03-14:22` or `12:40`. */
  readonly uptime: string | undefined
  /** Truncated command line of the listening process (which build is live). */
  readonly command: string | undefined
  /** Version or git line, whichever identifies the deployed build. */
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
  /** The launch token embedded in `url`; undefined for tokenless faces (e.g. 8490). */
  readonly token: string | undefined
}

export interface SysadminUrlsResult {
  readonly entries: readonly SysadminUrlEntry[]
}
