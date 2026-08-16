/**
 * WeChat quick-send as a model-invocable tool for the DeepSeek Harness.
 * @module @deepseek-ai/dsh-wechat
 *
 * Registers a single tool `wechat_send` that dispatches to the local
 * `wechat-send` skill script with WECLAW-first ordering (the WECLAW channel
 * looks nicer in the user's conversation; local weixinpush is the fallback),
 * reusing the same credential resolution and channel fallback the agent CLI
 * uses.
 *
 * The payload travels through the argv array (no shell interpolation), so text
 * with quotes/newlines hashes/HTML stays safe. Exposed on `ctx.tools`, so any
 * host/agent that mounts this plugin (web, dsh-tui, repl share it when the
 * profile bundles this package) can let the model send a WeChat message.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis plugin identity: mounted once per host where this package is bundled. */
export const name = 'wechat'
/** The tool registry must be ready before this plugin can register its tool. */
export const inject = ['tools']

/** The wechat-send skill script. Honors an override, else the agent skill dir. */
const SEND_SCRIPT = process.env.WECHAT_SEND_SCRIPT
  ?? join(homedir(), '.pi/agent/skills/wechat-send/scripts/send.py')
/** The Python interpreter used to run send.py. */
const PY = process.env.WECHAT_SEND_PY ?? 'python3'

/** Run send.py `--weclaw-first` with the given text; resolve the script's message. */
function runSend(text: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(PY, [SEND_SCRIPT, text, '--weclaw-first'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (b: Buffer) => { out += b.toString() })
    child.stderr.on('data', (b: Buffer) => { out += b.toString() })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 30_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      const ok = code === 0
      resolve(ok
        ? out.replace(/^.*(channel=[^\s),;]+).*$/s, '已发送到微信（$1）').replace(/[✅]/, '').trim()
        : (out.trim() || '发送失败：脚本无输出（微信配额或通道不可用？）'))
    })
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      resolve(`发送失败：无法调用 ${SEND_SCRIPT}（${error.message}）`)
    })
  })
}

/**
 * Mount the plugin: register the `wechat_send` tool the model can call.
 * @param ctx - Cordis context carrying the tools registry.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'wechat_send',
    description:
      'Send a plain-text message to WeChat. Use it when the user asks to send / push / notify some text to WeChat. '
      + 'Sends via the WECLAW channel, falling back to the local weixinpush channel.',
    parameters: {
      text: { type: 'string', required: true, description: 'The message text to send to WeChat.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 30_000,
    async execute({ text }: { readonly text: string }) {
      const trimmed = text.trim()
      if (trimmed === '') return '没有可发送的内容（空文本）'
      return runSend(trimmed)
    },
  }))
}
