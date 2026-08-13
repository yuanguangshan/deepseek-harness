#!/usr/bin/env node
/**
 * dsh-repl — 交互式命令行（类似 pi 的多轮对话体验）
 *
 * 基于 dsh 的 JSON-RPC 运行时：子进程跑 dsh-jsonrpc-agent，
 * 客户端保持同一 session 实现上下文记忆，事件流式输出。
 *
 * 命令：
 *   /new          开新会话（清空上下文）
 *   /exit, /quit  退出
 *   Ctrl+D        退出
 *
 * 环境变量：
 *   DSH_REPL_CONFIG    运行时配置（默认 ~/.dsh/interactive.cordis.yml）
 *   DSH_REPL_PROVIDER  渠道（默认 opencode-go）
 *   DSH_REPL_MODEL     模型（默认 deepseek-v4-flash）
 */
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import {
  describeToolArgs, interactiveConfig, repoRoot, runtimeBin, summarizeToolResult, isAbnormalTurnEnd,
} from './core.js'

const RUNTIME_BIN = runtimeBin()
const CONFIG = interactiveConfig()
const PROVIDER = process.env.DSH_REPL_PROVIDER ?? 'opencode-go'
const MODEL = process.env.DSH_REPL_MODEL ?? 'deepseek-v4-flash'

const C = {
  gray: s => `\x1b[90m${s}\x1b[0m`,
  blue: s => `\x1b[34m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
}

if (!existsSync(RUNTIME_BIN)) {
  console.error(C.red(`缺少运行时：${RUNTIME_BIN}\n请先执行 pnpm run build`))
  process.exit(1)
}
if (!existsSync(CONFIG)) {
  console.error(C.red(`缺少配置：${CONFIG}`))
  process.exit(1)
}

const cwd = process.cwd()
console.log(C.gray(`dsh-repl: ${PROVIDER}/${MODEL} @ ${cwd}`))
console.log(C.gray(`  运行时: ${RUNTIME_BIN}\n  配置:   ${CONFIG}\n  输入 /new 新会话, /exit 退出`))
console.log()

const client = new HarnessClient({
  command: process.execPath,
  args: [RUNTIME_BIN, CONFIG],
  cwd,
  env: process.env,
})

let sessionId = `repl-${randomUUID()}`
let busy = false
let activeSub = null

function newSession() {
  sessionId = `repl-${randomUUID()}`
  // 旧订阅在下一个通知时检测到会话切换自行退出
}

client.start()
try {
  await client.initialize({ cwd, provider: PROVIDER, model: MODEL })
} catch (error) {
  console.error(C.red(`初始化失败: ${error instanceof Error ? error.message : String(error)}`))
  process.exit(1)
}

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: C.bold('dsh> ') })

// 回合内渲染状态：text 累积用于错误上下文，reasoning 显示开关
let rendering = false
let reasoningVisible = false

function beginTurn() {
  rendering = true
}
function endTurn() {
  rendering = false
  process.stdout.write('\n')
}

async function handleLine(line) {
  const t = line.trim()
  if (t === '/exit' || t === '/quit') {
    rl.close()
    await client.close()
    process.exit(0)
  }
  if (t === '/new') {
    newSession()
    console.log(C.green(`(新会话: ${sessionId})`))
    return
  }
  if (t === '') return
  if (t.startsWith('/')) {
    console.log(C.gray('未知命令，可用: /new /exit /quit'))
    return
  }
  busy = true
  rl.pause()
  beginTurn()
  try {
    await client.prompt(sessionId, [{ type: 'text', text: line }])
  } catch (error) {
    console.error(C.red(`请求失败: ${error instanceof Error ? error.message : String(error)}`))
  }
}

rl.on('line', async (line) => {
  if (busy || rendering) return
  await handleLine(line)
  if (!busy && !rendering) rl.prompt()
})
rl.on('close', async () => {
  if (client) await client.close()
  process.exit(0)
})

// 事件订阅：流式打印（支持 /new 会话切换）
;(async () => {
  for (;;) {
    const sid = sessionId
    const sub = client.subscribeSessionTree(sid)
    activeSub = sub
    for await (const n of sub) {
      if (sid !== sessionId) break // 会话已切换，换订阅
      if (n.method !== 'session.event') continue
      const { sessionId: evSid, event } = n.params
      if (typeof evSid !== 'string' || evSid !== sid) continue
      if (event === null || typeof event !== 'object') continue
      const { type } = event
      const data = event.data ?? {}

      switch (type) {
        case 'turn/start':
          beginTurn()
          break
        case 'assistant/chunk': {
          const { chunk } = data
          if (rendering && chunk && typeof chunk === 'object') {
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') process.stdout.write(chunk.text)
            else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.trim() !== '') {
              // 仅显示首段 reasoning 前缀一次
              if (reasoningVisible === false) {
                process.stdout.write(C.gray('(思考) '))
                reasoningVisible = true
              }
              process.stdout.write(C.gray(chunk.text))
            }
            // tool-call-delta 是参数增量碎片，不逐块打印；等完整 tool/call 事件
          }
          break
        }
        case 'tool/call': {
          const name = data.name ?? '?'
          const args = describeToolArgs(data.arguments)
          process.stdout.write('\n' + C.blue(`⚙ ${name}(${args})`) + '\n')
          break
        }
        case 'tool/result': {
          const { summary, error } = summarizeToolResult(data)
          if (error) process.stdout.write(C.red('✗ 工具返回错误\n'))
          else if (summary) process.stdout.write(C.gray(`  → ${summary}\n`))
          else if (data.error) process.stdout.write(C.red(`✗ ${JSON.stringify(data.error)}\n`))
          else process.stdout.write(C.gray('✓ 工具完成\n'))
          break
        }
        case 'turn/end': {
          const reason = data.reason
          endTurn()
          if (isAbnormalTurnEnd(reason)) {
            process.stdout.write(`\x1b[33m(turn ended: ${JSON.stringify(reason)})\x1b[0m\n`)
          }
          busy = false
          reasoningVisible = false
          rl.resume()
          rl.prompt()
          break
        }
        case 'error': {
          process.stdout.write('\n' + C.red(`✗ ${JSON.stringify(data)}`) + '\n')
          busy = false
          reasoningVisible = false
          rl.resume()
          rl.prompt()
          break
        }
      }
    }
    if (sid === sessionId) break // 非切换的流结束：运行时退出
  }
})().catch((error) => {
  console.error(C.red(`订阅终止: ${error instanceof Error ? error.message : String(error)}`))
  process.exit(1)
})

rl.prompt()
