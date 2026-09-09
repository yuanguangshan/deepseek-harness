/** Local-machine service table and well-known paths for the sysadmin panel. */

import { homedir } from 'node:os'
import type { SysadminTargetId } from './types.ts'

export const DEV_ROOT = '/Users/ygs/ygs/deepseek-harness-dev'
export const WECLAW_ROOT = '/Users/ygs/ygs/weclaw'
export const DSH_HOME = `${homedir()}/.dsh`
export const WEB_DEV_SCRIPT = `${homedir()}/bin/dsh-web-dev`

/** launchd label per restartable service (KeepAlive agents on this machine). */
export const LAUNCHD_LABELS: Partial<Record<SysadminTargetId, string>> = {
  'web-official': 'com.ygs.dsh-web',
  'wechat-proxy': 'com.ygs.dsh-proxy',
}

export interface SysadminServiceSpec {
  readonly id: SysadminTargetId
  readonly port: number
  /** Factual source line shown next to the probe result. */
  readonly source: string
  readonly logPath: string
}

/** The three long-running dsh services this panel administrates. */
export const SERVICE_TABLE: readonly SysadminServiceSpec[] = [
  {
    id: 'web-official',
    port: 3080,
    source: '官方 npm 包 @deepseek-ai/dsh（alpha.2 线）',
    logPath: `${DSH_HOME}/logs/dsh-web.log`,
  },
  {
    id: 'web-dev',
    port: 3081,
    source: 'dev worktree 源码构建（apps/cli + packages/client）',
    logPath: `${DSH_HOME}/logs/dsh-web-dev.log`,
  },
  {
    id: 'wechat-proxy',
    port: 8490,
    source: 'weclaw 瘦包装 dsh-openai-server.mjs（微信 ygs 链）',
    logPath: `${WECLAW_ROOT}/dsh-proxy.log`,
  },
]

export function serviceSpec(target: SysadminTargetId): SysadminServiceSpec | undefined {
  return SERVICE_TABLE.find(spec => spec.id === target)
}
