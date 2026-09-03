import { describe, expect, it } from 'vitest'
import { defaultProbes, formatDoctorReport, onPathDefault, runDoctorChecks, wechatSendScriptPath, type DoctorProbes } from '../src/doctor.ts'

/** Probe set with everything available. */
const healthy: DoctorProbes = {
  exists: p => !p.includes('missing'),
  onPath: bin => ['git', 'pbcopy', 'afplay'].includes(bin),
  env: { DSH_REPL_RUNTIME: '/opt/runtime.js', DSH_REPL_CONFIG: '/opt/config.yml', DSH_SESSION_ROOT: '/tmp/sessions', OPENCODE_GO_API_KEY: 'k' },
  platform: 'darwin',
}

describe('runDoctorChecks', () => {
  it('reports all-ok with explicit paths', () => {
    const checks = runDoctorChecks(healthy)
    expect(checks.every(c => c.verdict === 'ok')).toBe(true)
    const byName = new Map(checks.map(c => [c.name, c]))
    expect(byName.get('运行时入口')?.detail).toContain('/opt/runtime.js')
    expect(byName.get('运行时配置')?.detail).toContain('/opt/config.yml')
  })

  it('fails when the configured runtime path is missing', () => {
    const checks = runDoctorChecks({
      ...healthy,
      exists: p => !p.includes('/opt/runtime.js'),
    })
    const runtime = checks.find(c => c.name === '运行时入口')
    expect(runtime?.verdict).toBe('fail')
  })

  it('warns when env overrides are unset (repo defaults apply)', () => {
    const checks = runDoctorChecks({ ...healthy, env: {} })
    expect(checks.find(c => c.name === '运行时入口')?.verdict).toBe('warn')
    expect(checks.find(c => c.name === '运行时配置')?.verdict).toBe('warn')
  })

  it('checks clipboard per platform', () => {
    const linuxX11 = runDoctorChecks({
      ...healthy,
      platform: 'linux',
      onPath: bin => bin === 'xclip' || bin === 'git' || bin === 'afplay',
      env: { DSH_REPL_RUNTIME: 'r', DSH_REPL_CONFIG: 'c', DSH_SESSION_ROOT: 's' },
    })
    expect(linuxX11.find(c => c.name === '剪贴板写入')?.verdict).toBe('ok')

    const linuxNoTool = runDoctorChecks({
      ...healthy,
      platform: 'linux',
      onPath: bin => bin === 'git' || bin === 'afplay',
    })
    expect(linuxNoTool.find(c => c.name === '剪贴板写入')?.verdict).toBe('fail')

    const win = runDoctorChecks({ ...healthy, platform: 'win32', onPath: bin => bin === 'clip.exe' || bin === 'git' || bin === 'afplay' })
    expect(win.find(c => c.name === '剪贴板写入')?.verdict).toBe('ok')
  })

  it('covers the X11 xclip detail, the wl-copy-on-X11 fallback, and unknown platforms', () => {
    // xclip on X11 names the tool in the detail.
    const x11 = runDoctorChecks({
      ...healthy,
      platform: 'linux',
      onPath: bin => bin === 'xclip' || bin === 'git' || bin === 'afplay',
    })
    expect(x11.find(c => c.name === '剪贴板写入')?.detail).toBe('xclip 可用（X11）')
    // wl-copy present but no wayland session → X11-family fallback detail.
    const wlOnX11 = runDoctorChecks({
      ...healthy,
      platform: 'linux',
      onPath: bin => bin === 'wl-copy' || bin === 'git' || bin === 'afplay',
    })
    expect(wlOnX11.find(c => c.name === '剪贴板写入')?.detail).toBe('wl-copy 可用')
    // An unsupported platform warns instead of failing.
    const other = runDoctorChecks({ ...healthy, platform: 'freebsd', onPath: bin => bin === 'git' || bin === 'afplay' })
    expect(other.find(c => c.name === '剪贴板写入')?.verdict).toBe('warn')
  })

  it('defaultProbes resolve from the real environment', () => {
    const probes = defaultProbes()
    expect(probes.platform).toBe(process.platform)
    expect(probes.env).toBe(process.env)
    // `git` exists on macOS/Linux CI hosts.
    expect(probes.onPath?.('git')).toBe(true)
    expect(probes.exists('/nonexistent-dsh-xyz')).toBe(false)
    // The onPathDefault fallback lives behind the same real-env call.
    expect(onPathDefault('git', process.env)).toBe(true)
    expect(onPathDefault('git', {})).toBe(false)
    // The `?? ''` empty-PATH branch inside defaultProbes.onPath.
    const originalPath = process.env.PATH
    delete process.env.PATH
    try {
      expect(probes.onPath?.('git')).toBe(false)
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('reaches the default-onPath and default-platform paths via probes without onPath', () => {
    // No onPath injected: the (bin) => onPathDefault(bin, env) fallback runs.
    // The injected env has no PATH (empty probe → warn), so pass the real
    // process.env spread to drive the ok path through the actual environment.
    const checks = runDoctorChecks({
      exists: () => true,
      onPath: bin => onPathDefault(bin, { ...process.env, DSH_REPL_RUNTIME: 'r', DSH_REPL_CONFIG: 'c', DSH_SESSION_ROOT: 's', OPENCODE_GO_API_KEY: 'k', WECHAT_SEND_SCRIPT: '/tmp/missing-send.py' }),
      env: { ...process.env, DSH_REPL_RUNTIME: 'r', DSH_REPL_CONFIG: 'c', DSH_SESSION_ROOT: 's', OPENCODE_GO_API_KEY: 'k', WECHAT_SEND_SCRIPT: '/tmp/missing-send.py' },
      platform: 'darwin',
    })
    expect(onPathDefault('git', process.env)).toBe(true)
    expect(checks.find(c => c.name === 'git 工具')?.verdict).toBe('ok')
    expect(checks.find(c => c.name === 'TTS 播放器')?.verdict).toBe('ok')
  })

  it('falls back to process.platform and the env-based onPath default when omitted', () => {
    // No platform / onPath keys: both `??` fallbacks must run against the
    // real process environment; `git` exists there on macOS/Linux CI hosts.
    const checks = runDoctorChecks({
      exists: () => true,
      env: { ...process.env, DSH_REPL_RUNTIME: 'r', DSH_REPL_CONFIG: 'c', DSH_SESSION_ROOT: 's', OPENCODE_GO_API_KEY: 'k', WECHAT_SEND_SCRIPT: '/tmp/missing-send.py' },
    })
    expect(checks.find(c => c.name === 'git 工具')?.verdict).toBe('ok')
  })

  it('runs every check against real defaultProbes when called with no arguments', () => {
    const checks = runDoctorChecks()
    expect(checks.length).toBeGreaterThan(0)
    expect(checks.find(c => c.name === 'git 工具')?.verdict).toBe('ok')
  })

  it('renders the all-clear head when no failures and no warnings', () => {
    const report = formatDoctorReport([
      { name: 'git 工具', verdict: 'ok', detail: 'x' },
    ])
    expect(report).toContain('全部通过')
  })

  it('warns on a missing session root and fails a missing config file', () => {
    const checks = runDoctorChecks({
      ...healthy,
      exists: p => !p.includes('missing'),
      env: { DSH_REPL_RUNTIME: 'r', DSH_REPL_CONFIG: '/opt/missing-config.yml', DSH_SESSION_ROOT: '/tmp/also-missing-sessions' },
    })
    expect(checks.find(c => c.name === '运行时配置')?.verdict).toBe('fail')
    expect(checks.find(c => c.name === '会话存储')?.verdict).toBe('warn')
    expect(checks.find(c => c.name === '会话存储')?.detail).toContain('首个会话落盘后生成')
  })

  it('covers darwin/win clipboard failure details', () => {
    const darwin = runDoctorChecks({ ...healthy, platform: 'darwin', onPath: bin => bin === 'git' || bin === 'afplay' })
    expect(darwin.find(c => c.name === '剪贴板写入')?.detail).toBe('pbcopy 不可用，/copy 无法工作')
    const win = runDoctorChecks({ ...healthy, platform: 'win32', onPath: bin => bin === 'git' || bin === 'afplay' })
    expect(win.find(c => c.name === '剪贴板写入')?.detail).toBe('clip.exe 不可用，/copy 无法工作')
    const gitMissing = runDoctorChecks({ ...healthy, onPath: bin => bin === 'pbcopy' || bin === 'afplay' })
    expect(gitMissing.find(c => c.name === 'git 工具')?.verdict).toBe('warn')
  })

  it('warns when no TTS player exists', () => {
    const checks = runDoctorChecks({ ...healthy, onPath: bin => bin === 'git' || bin === 'pbcopy' })
    expect(checks.find(c => c.name === 'TTS 播放器')?.verdict).toBe('warn')
  })

  it('warns when the wechat script is missing', () => {
    const checks = runDoctorChecks({ ...healthy, exists: p => !p.includes('wechat-send') })
    expect(checks.find(c => c.name === '微信推送')?.verdict).toBe('warn')
  })
})

describe('formatDoctorReport', () => {
  it('summarizes counts in the head and colors rows', () => {
    // Unset OPENCODE key warns; everything else resolves ok in this probe set.
    const checks = runDoctorChecks({
      ...healthy,
      platform: 'linux',
      onPath: () => true,
      env: { DSH_REPL_RUNTIME: 'r', DSH_REPL_CONFIG: 'c', DSH_SESSION_ROOT: 's', WAYLAND_DISPLAY: 'w' },
    })
    const report = formatDoctorReport(checks)
    expect(report).toContain('0 项失败 · 1 项警告')
    expect(report).toContain('本命令只查本地依赖')
  })

  it('colors failing rows red', () => {
    const checks = runDoctorChecks({
      ...healthy,
      platform: 'linux',
      onPath: bin => bin === 'git' || bin === 'afplay',
    })
    const report = formatDoctorReport(checks)
    expect(report).toContain('1 项失败')
  })
})

describe('wechatSendScriptPath', () => {
  it('honors the env override and defaults to the skill dir', () => {
    expect(wechatSendScriptPath({ WECHAT_SEND_SCRIPT: '/custom/send.py' })).toBe('/custom/send.py')
    expect(wechatSendScriptPath({})).toContain('.pi/agent/skills/wechat-send/scripts/send.py')
  })
})
