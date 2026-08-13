#!/usr/bin/env node
/**
 * dsh-repl (TUI 版) — 参考 pi 界面：顶部状态条 + 滚动对话区 + 底部多行编辑器
 *
 * 基于 dsh JSON-RPC 运行时 + @earendil-works/pi-tui 渲染。
 * 数据层与行式版 repl.mjs 相同：spawn jsonrpc-agent → HarnessClient → 事件流。
 *
 * 命令：
 *   /new          新会话（清空上下文）
 *   /exit, /quit  退出
 *   Ctrl+C        退出
 */
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import {
  Box, Container, Editor, Markdown, ProcessTerminal, ScrollView,
  Text, TuiAltScreen, VStack, matchesKey, truncateToWidth, visibleWidth,
} from '@earendil-works/pi-tui'

const HARNESS = '/Users/ygs/ygs/deepseek-harness'
const RUNTIME_BIN = join(HARNESS, 'packages/examples/jsonrpc-demo/lib/bin.js')
const CONFIG = process.env.DSH_REPL_CONFIG ?? join(HARNESS, 'examples/jsonrpc-agent/interactive.cordis.yml')
const PROVIDER = process.env.DSH_REPL_PROVIDER ?? 'opencode-go'
const MODEL = process.env.DSH_REPL_MODEL ?? 'deepseek-v4-flash'

// ---- 颜色（ANSI，参考 pi 主题语义）----
// 单行状态栏：左侧指标 + 右侧模型，超长截断不换行
class StatusBar {
  constructor() {
    this.left = ''
    this.right = ''
  }
  setText(left, right) {
    this.left = left
    this.right = right
  }
  invalidate() {}
  render(width) {
    const rw = visibleWidth(this.right)
    const leftMax = Math.max(0, width - rw - 2)
    const left = visibleWidth(this.left) > leftMax
      ? truncateToWidth(this.left, Math.max(0, leftMax - 1)) + '…'
      : this.left
    const pad = ' '.repeat(Math.max(1, width - visibleWidth(left) - rw))
    return [left + pad + this.right]
  }
}
const C = {
  blue: s => `\x1b[34m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
  gray: s => `\x1b[90m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  italic: s => `\x1b[3m${s}\x1b[0m`,
  bgBlue: s => `\x1b[44m${s}\x1b[0m`,
  bgGray: s => `\x1b[100m${s}\x1b[0m`,
}

if (!existsSync(RUNTIME_BIN) || !existsSync(CONFIG)) {
  console.error(C.red(`缺少运行时或配置：\n  ${RUNTIME_BIN}\n  ${CONFIG}\n请先 pnpm run build`))
  process.exit(1)
}

// ---- 运行时 ----
const cwd = process.cwd()
const client = new HarnessClient({
  command: process.execPath,
  args: [RUNTIME_BIN, CONFIG],
  cwd,
  env: process.env,
})

let sessionId = `repl-${randomUUID()}`
let busy = false
let shuttingDown = false

// ---- TUI ----
const terminal = new ProcessTerminal()
const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true })

// 主题
const mdTheme = {
  heading: text => C.bold(C.cyan(text)),
  link: text => C.blue(text),
  linkUrl: text => C.gray(text),
  code: text => C.cyan(text),
  codeBlock: text => text,
  codeBlockBorder: text => C.gray(text),
  quote: text => C.gray(C.italic(text)),
  quoteBorder: text => C.gray(text),
  hr: text => C.gray(text),
  listBullet: text => C.blue(text),
  bold: text => C.bold(text),
  italic: text => C.italic(text),
  strikethrough: text => C.gray(text),
  underline: text => text,
}
const editorTheme = {
  borderColor: text => C.blue(text),
  selectList: {
    selectedPrefix: text => C.cyan(text),
    selectedText: text => text,
    description: text => C.gray(text),
    scrollInfo: text => C.gray(text),
    noMatch: text => C.yellow(text),
  },
}

// ---- 组件 ----
const transcript = new Container()
const scroll = new ScrollView(transcript, { follow: 'end', primary: true, overscroll: 'contain', scrollbar: 'auto' })
const editor = new Editor(tui, editorTheme)
const statusBar = new StatusBar()
const status = new Text('', 0, 0)

function setStatus(text) {
  status.setText(text)
  tui.requestRender()
}

tui.setLayoutRoot(new VStack([
  {
    component: new Text(` dsh-repl  ${C.gray(`· ${PROVIDER} / ${MODEL}`)}  ${C.gray('· /new 新会话  /exit 退出')}`, 1, 0),
    basis: 'auto', shrink: 0,
  },
  { component: scroll, basis: 0, grow: 1, minSize: 3 },
  { component: editor, basis: 'auto', shrink: 1, minSize: 3 },
  { component: statusBar, basis: 'auto', shrink: 0 },
  { component: status, basis: 'auto', shrink: 0 },
]))
tui.setFocus(editor)

// ---- 会话指标（对应 web StatsLine + ContextMeter）----
const stats = {
  turns: 0, steps: 0,
  llmMs: 0, toolMs: 0,
  ttftMs: 0, ttftSteps: 0,
  decodeMs: 0, decodeTokens: 0,
  billedInput: 0, outputTokens: 0, cacheRead: 0,
  contextWindow: undefined,
  lastBilledInput: 0,
  providerName: PROVIDER,
  modelName: MODEL,
  // 计时临时态
  stepStart: undefined, decodeStart: undefined, toolStart: undefined, sawChunk: false,
}

function fmtTokens(n) {
  const scaled = v => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}
function fmtDuration(ms) {
  const s = ms / 1_000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

function renderStats() {
  const g = []
  if (stats.steps > 0) {
    g.push(`${stats.turns} ${C.gray('轮')} · ${stats.steps} ${C.gray('步')}`)
    const d = []
    if (stats.llmMs > 0) d.push(`${C.cyan('LLM')} ${fmtDuration(stats.llmMs)}`)
    if (stats.toolMs > 0) d.push(`${C.cyan('工具调用')} ${fmtDuration(stats.toolMs)}`)
    if (d.length > 0) g.push(d.join(' · '))
    const sp = []
    if (stats.ttftSteps > 0) sp.push(`${C.cyan('首 token 平均')} ${fmtDuration(stats.ttftMs / stats.ttftSteps)}`)
    if (stats.decodeMs > 0) {
      const tps = stats.decodeTokens / (stats.decodeMs / 1_000)
      sp.push(`${Math.round(tps * 10) / 10} ${C.cyan('tok/s')}`)
    }
    if (sp.length > 0) g.push(sp.join(' · '))
  }
  if (stats.billedInput > 0 || stats.outputTokens > 0) {
    if (stats.cacheRead > 0) {
      g.push(`${C.green('缓存命中')} ${Math.round(stats.cacheRead / stats.billedInput * 100)}%`)
    }
    g.push(`${C.gray('输入')} ${fmtTokens(stats.billedInput)} tokens · ${C.gray('输出')} ${fmtTokens(stats.outputTokens)} tokens`)
    if (stats.contextWindow !== undefined && stats.lastBilledInput > 0) {
      const pct = Math.min(100, Math.round(stats.lastBilledInput / stats.contextWindow * 100))
      g.push(`${C.yellow('ctx')} ${pct}%`)
    }
  }
  statusBar.setText(
    g.length > 0 ? g.join('  ' + C.gray('|') + '  ') : C.gray('指标将在此显示'),
    `${C.blue(stats.providerName)} · ${C.green(stats.modelName)}`,
  )
  tui.requestRender()
}

// ---- 消息渲染 ----
let thinkingView = null       // 当前思考组件（灰色）
let assistantView = null      // 当前 assistant Markdown 组件
let assistantBuf = ''         // 当前 assistant 文本累积
let toolView = null           // 当前工具组件
let toolBuf = ''              // 当前工具文本累积

function addUser(text) {
  const box = new Box(1, 0, s => C.bgBlue(s))
  box.addChild(new Text(text, 1, 0))
  transcript.addChild(box)
  tui.requestRender()
}

function startAssistant() {
  assistantBuf = ''
  assistantView = new Markdown('', 1, 0, mdTheme)
  transcript.addChild(assistantView)
  tui.requestRender()
}

function appendAssistant(text) {
  if (!assistantView) startAssistant()
  assistantBuf += text
  assistantView.setText(assistantBuf)
  tui.requestRender()
}

function addToolCall(name, args) {
  toolBuf = `\n${C.blue(`⚙ ${name}(${args})`)}\n`
  toolView = new Text(toolBuf, 1, 0)
  transcript.addChild(toolView)
  tui.requestRender()
}

function addToolResult(summary) {
  if (toolView) {
    toolBuf += `  ${C.gray(`→ ${summary}`)}\n`
    toolView.setText(toolBuf)
  }
  tui.requestRender()
}

function finishTurn() {
  thinkingView = null
  assistantView = null
  assistantBuf = ''
  toolView = null
  toolBuf = ''
  busy = false
  editor.disableSubmit = false
  tui.requestRender()
}

function addThinkingLine(text) {
  if (!thinkingView) {
    thinkingView = new Text(C.gray('(思考) '), 1, 0)
    transcript.addChild(thinkingView)
  }
  thinkingView.setText(thinkingView.getText() + text)
  tui.requestRender()
}

// ---- 输入 ----
async function submit(text) {
  const t = text.trim()
  if (t === '') return
  if (t === '/exit' || t === '/quit') {
    await shutdown()
    return
  }
  if (t === '/new') {
    sessionId = `repl-${randomUUID()}`
    addUser(`(新会话)`)
    setStatus(`会话: ${sessionId.slice(0, 20)}…`)
    return
  }
  if (t.startsWith('/')) {
    addUser(`未知命令: ${t}`)
    return
  }
  addUser(text)
  busy = true
  editor.disableSubmit = true
  setStatus('思考中… (Esc 无法取消，等本轮完成)')
  try {
    await client.prompt(sessionId, [{ type: 'text', text: t }])
  } catch (error) {
    addToolResult(`请求失败: ${error instanceof Error ? error.message : String(error)}`)
    finishTurn()
  }
}

editor.onSubmit = submit

// ---- 事件流（在 client.start() 之后由启动块调用）----
async function runSubscription() {
  for (;;) {
    const sid = sessionId
    const sub = client.subscribeSessionTree(sid)
    for await (const n of sub) {
      if (sid !== sessionId) break
      if (n.method !== 'session.event') continue
      const { sessionId: evSid, event } = n.params
      if (typeof evSid !== 'string' || evSid !== sid) continue
      if (event === null || typeof event !== 'object') continue
      const { type } = event
      const data = event.data ?? {}

      switch (type) {
        case 'turn/start':
          stats.turns += 1
          break
        case 'step/start':
          stats.steps += 1
          stats.stepStart = event.time
          stats.decodeStart = undefined
          stats.sawChunk = false
          break
        case 'assistant/chunk': {
          const { chunk } = data
          if (chunk && typeof chunk === 'object') {
            if (!stats.sawChunk && stats.stepStart !== undefined) {
              stats.sawChunk = true
              stats.ttftMs += Math.max(0, event.time - stats.stepStart)
              stats.ttftSteps += 1
              stats.decodeStart = event.time
            }
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') appendAssistant(chunk.text)
            else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.trim() !== '') addThinkingLine(chunk.text)
          }
          break
        }
        case 'assistant/message': {
          if (stats.stepStart !== undefined) {
            stats.llmMs += Math.max(0, event.time - stats.stepStart)
            if (stats.decodeStart !== undefined) stats.decodeMs += Math.max(0, event.time - stats.decodeStart)
          }
          const usage = data.usage
          if (usage && typeof usage === 'object') {
            const input = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
            const out = usage.outputTokens ?? 0
            stats.billedInput += input
            stats.outputTokens += out
            stats.cacheRead += usage.cacheReadTokens ?? 0
            stats.lastBilledInput = input
            if (stats.decodeStart !== undefined) stats.decodeTokens += out
          }
          renderStats()
          break
        }
        case 'request/context': {
          if (typeof data.contextWindow === 'number') stats.contextWindow = data.contextWindow
          if (typeof data.model === 'string' && data.model !== '') {
            stats.modelName = data.model
            stats.providerName = typeof data.provider === 'string' && data.provider ? data.provider : PROVIDER
          }
          renderStats()
          break
        }
        case 'tool/call': {
          stats.toolStart = event.time
          const name = data.name ?? '?'
          let args = String(data.arguments ?? '')
          try { args = JSON.stringify(JSON.parse(args)) } catch { /* keep raw */ }
          if (args.length > 200) args = args.slice(0, 200) + '…'
          addToolCall(name, args)
          break
        }
        case 'tool/result': {
          if (stats.toolStart !== undefined) {
            stats.toolMs += Math.max(0, event.time - stats.toolStart)
            renderStats()
          }
          const msg = data.message
          const texts = []
          if (msg && typeof msg === 'object' && Array.isArray(msg.content)) {
            for (const b of msg.content) {
              if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
            }
          }
          if (texts.length > 0) {
            let summary = texts.join(' ').replace(/\s+/g, ' ').trim()
            if (summary.length > 160) summary = summary.slice(0, 160) + '…'
            if (summary) addToolResult(summary)
          } else if (data.error) {
            addToolResult(C.red(`✗ ${JSON.stringify(data.error)}`))
          } else {
            addToolResult('✓')
          }
          break
        }
        case 'turn/end': {
          const reason = data.reason
          const kind = reason && typeof reason === 'object' ? reason.kind : reason
          if (kind && kind !== 'completed' && kind !== 'success' && kind !== 'stop') {
            addToolResult(C.red(`✗ turn 异常: ${JSON.stringify(reason)}`))
          }
          stats.stepStart = undefined
          stats.decodeStart = undefined
          stats.toolStart = undefined
          finishTurn()
          renderStats()
          setStatus('就绪')
          break
        }
        case 'error': {
          addToolResult(C.red(`✗ ${JSON.stringify(data)}`))
          finishTurn()
          setStatus('出错')
          break
        }
      }
    }
    if (sid === sessionId) break
  }
}

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  // 第一步：同步恢复终端（raw mode/鼠标/光标），无论后续清理是否成功
  try {
    tui.stop()
  } catch { /* 忽略恢复异常 */ }
  // 第二步：异步关闭子进程，带兑底退出，绝不让进程挂着 raw 终端
  void (async () => {
    try {
      await Promise.race([
        client.close(),
        new Promise(resolve => setTimeout(resolve, 3000)),
      ])
    } catch { /* 忽略 */ }
    process.exit(0)
  })()
}

// Ctrl+C 退出
tui.addInputListener((data) => {
  if (matchesKey(data, 'ctrl+c')) {
    void shutdown()
    return true
  }
  return false
})

// ---- 启动 ----
function addWelcome() {
  const tag = C.green('yuanguangshan定制版')
  const tagCol = 34
  const padTo = (s, col) => s + ' '.repeat(Math.max(0, col - visibleWidth(s)))
  const art = [
    padTo('       ~   ~   ~   ~', tagCol) + tag,
    '      ~     ~     ~',
    '    ╭───────────────────╮',
    '   ╭╯                   ╰╮',
    '  ╭╯    ●         ●      ╰╮',
    '  ╰╮        ▄▄▄▄         ╭╯',
    '   ╰╮                     ╭╯',
    '    ╰─────────────────────╯',
    '       ╲╱         ╲╱',
    '',
    `  ${C.bold('欢迎使用 DeepSeek Harness')}`,
    `  ${C.gray('────────────────────────────')}`,
    `  ${C.cyan(PROVIDER)} · ${C.green(MODEL)}`,
    `  输入问题开始对话 · ${C.gray('/new')} 新会话 · ${C.gray('/exit')} 退出`,
  ].join('\n')
  // 透明背景
  transcript.addChild(new Text(art, 1, 0))
  tui.requestRender()
}

client.start()
try {
  await client.initialize({ cwd, provider: PROVIDER, model: MODEL })
} catch (error) {
  await tui.stop()
  console.error(C.red(`初始化失败: ${error instanceof Error ? error.message : String(error)}`))
  process.exit(1)
}
addWelcome()
setStatus('就绪')
tui.start()
// 订阅在 client.start() 之后建立，才能收到事件流
void runSubscription().catch(async (error) => {
  if (shuttingDown) process.exit(0)
  if (tui) {
    try { tui.stop() } catch { /* ignore */ }
  }
  console.error(C.red(`订阅终止: ${error instanceof Error ? error.message : String(error)}`))
  process.exit(1)
})
