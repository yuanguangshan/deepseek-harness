/**
 * The `/text2card` skill pipeline: one sentence → hand-drawn card PNG (via the
 * text2card skill script) → R2 upload → WeChat push with the public image link.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const TEXTCARD_RUN = join(homedir(), '.pi/agent/skills/text2card/scripts/run.sh')
const SEND_PY = join(homedir(), '.pi/agent/skills/wechat-send/scripts/send.py')
const R2_REMOTE = 'r2:yuangs/handdrawn'
const R2_BASE = 'https://pic.want.biz/handdrawn'

/** Spawn a command, collect stdout/stderr, resolve [code, stdout]. */
function runCmd(bin: string, args: string[]): Promise<[number, string, string]> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { cwd: homedir() })
    let out = '', err = ''
    p.stdout.on('data', (d: Buffer) => { out += d.toString() })
    p.stderr.on('data', (d: Buffer) => { err += d.toString() })
    p.on('error', (e: Error) => { resolve([-1, out, err || e.message]) })
    p.on('close', (code) => { resolve([code ?? -1, out, err]) })
  })
}

/** Spawn a command, stream stdout lines to a callback, resolve [code, full stdout]. */
function runCmdStream(bin: string, args: string[], onLine: (line: string) => void): Promise<[number, string, string]> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { cwd: homedir() })
    let err = '', buf = ''
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) onLine(line.trim())
      }
    })
    p.stderr.on('data', (d: Buffer) => { err += d.toString() })
    p.on('error', (e: Error) => { resolve([-1, '', err || e.message]) })
    p.on('close', (code) => {
      if (buf.trim()) onLine(buf.trim())
      resolve([code ?? -1, buf, err])
    })
  })
}

/** Run the text2card skill (一句话 → 手绘图文卡片), save PNG, upload to R2, then send to WeChat.
 *  onStatus: 实时更新 TUI 状态栏（逐行回调 text2card 的 stdout）。 */
export async function runText2Card(desc: string, onStatus?: (text: string) => void): Promise<string> {
  const dir = join(homedir(), 'text2card')
  try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  const out = join(dir, `card-${Date.now()}.png`)

  // 1. 生成卡片（流式更新状态）
  const [, tOut] = await runCmdStream('bash', [TEXTCARD_RUN, desc, '-o', out], (line) => { if (onStatus) onStatus(line) })
  if (!existsSync(out)) {
    return `✗ text2card 生成失败：\n${(tOut || '').trim().slice(0, 300)}`
  }
  const base = out.split(/[\\/]/).pop() ?? 'card.png'
  const link = `${R2_BASE}/${encodeURIComponent(base)}`

  // 2. 上传 R2
  if (onStatus) onStatus('☁️ 上传 R2…')
  const [rc] = await runCmd('rclone', ['copy', out, R2_REMOTE])
  if (rc !== 0) {
    return `✓ 已生成 ${out}\n⚠️ R2 上传失败，未发微信`
  }

  // 3. 发微信（走 wechat-send 的 media 通道）
  if (onStatus) onStatus('💬 推送微信…')
  const [wc, , werr] = await runCmd('python3', [SEND_PY, `🎨 手绘图文卡片：${desc}`, '--media', link])
  if (wc === 0) {
    return `✓ 已生成并发送微信\n📄 本地: ${out}\n🔗 ${link}`
  }
  return `✓ 已生成，R2 已传但微信发送失败${werr ? `：${werr.trim().slice(0, 200)}` : ''}\n📄 本地: ${out}\n🔗 ${link}`
}
