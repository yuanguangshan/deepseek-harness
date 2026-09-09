/** Browser fetch face over the host sysadmin /api routes. */

import type {
  SysadminLogsResult,
  SysadminRestartResult,
  SysadminSnapshot,
  SysadminTargetId,
  SysadminUrlsResult,
} from '../types.ts'

/** Registration-side API used by the section component. */
export interface SysadminInjected {
  status: () => Promise<SysadminSnapshot>
  restart: (target: SysadminTargetId) => Promise<SysadminRestartResult>
  logs: (target: SysadminTargetId, lines?: number) => Promise<SysadminLogsResult>
  urls: () => Promise<SysadminUrlsResult>
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'include', ...init })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json() as T
}

export function createSysadminApi(): SysadminInjected {
  return {
    status: () => request<SysadminSnapshot>('/api/sysadmin/status'),
    restart: target => request<SysadminRestartResult>('/api/sysadmin/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target }),
    }),
    logs: (target, lines = 60) => request<SysadminLogsResult>(
      `/api/sysadmin/logs?target=${encodeURIComponent(target)}&lines=${lines}`,
    ),
    urls: () => request<SysadminUrlsResult>('/api/sysadmin/urls'),
  }
}
