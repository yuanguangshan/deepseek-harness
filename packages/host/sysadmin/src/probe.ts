/** Status probes for the sysadmin panel: ports, pids, versions, 8490 face. */

import { execFile } from 'node:child_process'
import { readFile, readlink, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { promisify } from 'node:util'
import { DEV_ROOT, SERVICE_TABLE, WECLAW_ROOT } from './services.ts'
import type { SysadminServiceStatus, SysadminSnapshot, SysadminTargetId } from './types.ts'

const execFileText = promisify(execFile)

/** Run one command to text; a nonzero exit or timeout resolves to undefined. */
async function tryExec(file: string, args: readonly string[], timeoutMs = 2_500): Promise<string | undefined> {
  try {
    const { stdout } = await execFileText(file, [...args], { timeout: timeoutMs })
    return stdout
  } catch {
    return undefined
  }
}

/** True when something accepts TCP connections on the port right now. */
function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (result: boolean): void => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(600)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function pidOfPort(port: number): Promise<number | undefined> {
  const out = await tryExec('/usr/sbin/lsof', ['-ti', `TCP:${port}`, '-sTCP:LISTEN'])
  const pid = Number.parseInt(out?.split('\n')[0] ?? '', 10)
  return Number.isFinite(pid) ? pid : undefined
}

interface PsInfo {
  readonly uptime: string | undefined
  readonly command: string | undefined
}

async function psInfo(pid: number): Promise<PsInfo> {
  const out = await tryExec('/bin/ps', ['-p', String(pid), '-o', 'etime=', '-o', 'command='])
  if (out === undefined) return { uptime: undefined, command: undefined }
  const line = out.trimStart()
  const cut = line.indexOf(' ')
  if (cut <= 0) return { uptime: undefined, command: undefined }
  return {
    uptime: line.slice(0, cut).trim() || undefined,
    command: line.slice(cut + 1).trim().slice(0, 160) || undefined,
  }
}

/** Version of the globally installed dsh, resolved through the bin symlink. */
async function officialDshVersion(): Promise<string | undefined> {
  try {
    const link = await readlink('/opt/homebrew/bin/dsh')
    const binPath = link.startsWith('/') ? link : `/opt/homebrew/bin/${link}`
    // .../node_modules/@deepseek-ai/dsh/lib/bin.js — the owning package root
    // is three levels up from lib/bin.js.
    const parts = binPath.split('/')
    const root = `${parts.slice(0, parts.length - 3).join('/')}/package.json`
    const raw = await readFile(root, 'utf8')
    return (JSON.parse(raw) as { version?: string }).version
  } catch {
    return undefined
  }
}

const gitCache = new Map<string, { readonly at: number; readonly line: string }>()
const GIT_CACHE_MS = 60_000

/** `branch @ short-sha` for one repository, cached briefly (status polls). */
async function gitLine(root: string): Promise<string | undefined> {
  const cached = gitCache.get(root)
  if (cached !== undefined && Date.now() - cached.at < GIT_CACHE_MS) return cached.line
  const branch = (await tryExec('/usr/bin/git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
  const sha = (await tryExec('/usr/bin/git', ['-C', root, 'rev-parse', '--short', 'HEAD']))?.trim()
  const line = branch !== undefined && sha !== undefined ? `${branch} @ ${sha}` : undefined
  if (line !== undefined) gitCache.set(root, { at: Date.now(), line })
  return line
}

/** /v1/status face of the wechat proxy, authenticated by its bearer file. */
async function wechatProxyDetail(): Promise<string | undefined> {
  try {
    const token = (await readFile(`${WECLAW_ROOT}/dsh-proxy.token`, 'utf8')).trim()
    const response = await fetch('http://127.0.0.1:8490/v1/status', {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1_200),
    })
    if (!response.ok) return `HTTP ${response.status}`
    const body = await response.json() as { busy?: boolean; model?: string }
    const model = body.model ?? '未知模型'
    return `${model}${body.busy === true ? ' · 回合进行中' : ' · 空闲'}`
  } catch (error) {
    return error instanceof Error && error.name === 'TimeoutError' ? '状态接口超时' : undefined
  }
}

async function versionFor(target: SysadminTargetId): Promise<string | undefined> {
  switch (target) {
    case 'web-official': return officialDshVersion()
    case 'web-dev': return gitLine(DEV_ROOT)
    case 'wechat-proxy': return gitLine(WECLAW_ROOT)
  }
}

async function detailFor(target: SysadminTargetId): Promise<string | undefined> {
  return target === 'wechat-proxy' ? wechatProxyDetail() : undefined
}

async function statusFor(
  spec: (typeof SERVICE_TABLE)[number],
): Promise<SysadminServiceStatus> {
  const running = await portListening(spec.port)
  if (!running) {
    return {
      id: spec.id, port: spec.port, running: false,
      pid: undefined, uptime: undefined, command: undefined,
      version: await versionFor(spec.id), detail: undefined,
    }
  }
  const pid = await pidOfPort(spec.port)
  const [ps, version, detail] = await Promise.all([
    pid === undefined ? Promise.resolve({ uptime: undefined, command: undefined }) : psInfo(pid),
    versionFor(spec.id),
    detailFor(spec.id),
  ])
  return {
    id: spec.id, port: spec.port, running: true,
    pid: pid ?? undefined, uptime: ps.uptime, command: ps.command,
    version, detail,
  }
}

let snapshotCache: { readonly at: number; readonly value: SysadminSnapshot } | undefined
const SNAPSHOT_CACHE_MS = 4_000

/** Probe every service in parallel; results are cached briefly for polls. */
export async function createStatusSnapshot(): Promise<SysadminSnapshot> {
  if (snapshotCache !== undefined && Date.now() - snapshotCache.at < SNAPSHOT_CACHE_MS) {
    return snapshotCache.value
  }
  const services = await Promise.all(SERVICE_TABLE.map(spec => statusFor(spec)))
  const value: SysadminSnapshot = { generatedAt: Date.now(), services }
  snapshotCache = { at: Date.now(), value }
  return value
}

/** Log file size guard for the tails endpoint. */
export async function logPathExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
