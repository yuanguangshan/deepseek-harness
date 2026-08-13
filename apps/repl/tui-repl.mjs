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
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import {
  createStats, fixCommand, fmtDuration, fmtTokens, formatModelTag, formatStatsLine,
  loadModelsFromConfig, pickRoute, statsOnEvent,
} from './core.js'
import {
  CombinedAutocompleteProvider, Container, Editor, Markdown, ProcessTerminal, ScrollView,
  SelectList, Text, TuiAltScreen, VStack, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi,
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
  // 用户气泡底色：只在文字内容上铺色（见 UserBubble），不再是整行深蓝条
  bubbleBg: s => `\x1b[44m${s}\x1b[0m`,
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

function newSession() {
  sessionId = `repl-${randomUUID()}`
}

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

// 强制滚动到底部：ScrollView 的 followingEnd 在用户手动滚动后失效，
// 新内容不再自动跟随（模型回复会被推走）；内容更新时显式归位。
function scrollToEnd() {
  scroll.scrollToEnd()
}
const editor = new Editor(tui, editorTheme)
// 斜杠命令自动补全 + 文件路径补全（Tab）
editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
  { name: 'model', description: '切换模型（选择器）' },
  { name: 'models', description: '列出可用模型' },
  { name: 'new', description: '新会话（清空上下文）' },
  { name: 'compact', description: '压缩当前会话上下文' },
  { name: 'feedback', description: '反馈' },
  { name: 'goal', description: '目标（/goal set <目标> 创建）' },
  { name: 'export', description: '导出会话' },
  { name: 'exit', description: '退出' },
  { name: 'quit', description: '退出' },
], cwd))
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
const stats = createStats(PROVIDER, MODEL)

function renderStats() {
  statusBar.setText(
    formatStatsLine(stats, { gray: C.gray, cyan: C.cyan, green: C.green, yellow: C.yellow }) || C.gray('指标将在此显示'),
    formatModelTag(C.blue(stats.providerName), C.green(stats.modelName)),
  )
  tui.requestRender()
}

// ---- 消息渲染 ----
let thinkingView = null       // 当前思考组件（灰色）
let thinkingBuf = ''          // 当前思考文本累积
let assistantView = null      // 当前 assistant Markdown 组件
let assistantBuf = ''         // 当前 assistant 文本累积
let toolView = null           // 当前工具组件
let toolBuf = ''              // 当前工具文本累积

// 用户消息气泡：蓝底只罩住文字内容（气泡式），不再整行铺满深蓝条。
// 按实际渲染宽度自动换行，终端尺寸变化时自适应，右缘留透明空隙。
class UserBubble {
  constructor(text) {
    this.text = text
    this.label = C.bold(C.cyan('你'))  // 气泡左侧标签
    this.padX = 1                      // 气泡内左右留白
  }
  invalidate() {}
  render(width) {
    const indent = 1
    const labelW = visibleWidth(this.label)
    const firstPrefixW = indent + labelW + 1
    const wrapW = Math.max(1, width - firstPrefixW - this.padX * 2)
    const lines = []
    const paragraphs = this.text.split('\n')
    for (let p = 0; p < paragraphs.length; p++) {
      const para = paragraphs[p]
      if (para.trim() === '') {
        lines.push('')
        continue
      }
      const wrapped = wrapTextWithAnsi(para.replace(/\t/g, '   '), wrapW)
      for (let w = 0; w < wrapped.length; w++) {
        const cell = ' '.repeat(this.padX) + wrapped[w] + ' '.repeat(this.padX)
        const bubble = C.bubbleBg(cell)  // 色只在文字+气泡内 padding，右侧在 reset 之后 → 透明
        lines.push(w === 0 && p === 0
          ? ' '.repeat(indent) + this.label + ' ' + bubble
          : ' '.repeat(firstPrefixW) + bubble)
      }
    }
    return lines
  }
}

function addUser(text) {
  transcript.addChild(new UserBubble(text))
  scrollToEnd()
  tui.requestRender()
}

function startAssistant() {
  assistantBuf = ''
  assistantView = new Markdown('', 1, 0, mdTheme)
  transcript.addChild(assistantView)
  scrollToEnd()
  tui.requestRender()
}

function appendAssistant(text) {
  if (!assistantView) startAssistant()
  assistantBuf += text
  assistantView.setText(assistantBuf)
  scrollToEnd()
  tui.requestRender()
}

function addToolCall(name, args) {
  toolBuf = `${C.blue(`⚙ ${name}(${args})`)}\n`
  toolView = new Text(toolBuf, 1, 0)
  transcript.addChild(toolView)
  scrollToEnd()
  tui.requestRender()
}

function addToolResult(summary) {
  if (toolView) {
    toolBuf += `  ${C.gray(`→ ${summary}`)}\n`
    toolView.setText(toolBuf)
  } else {
    // 无 toolView（如命令结果：/compact 等不走 tool/call 事件）：新建结果卡片
    toolBuf = `  ${C.gray(`→ ${summary}`)}\n`
    toolView = new Text(toolBuf, 1, 0)
    transcript.addChild(toolView)
  }
  scrollToEnd()
  tui.requestRender()
}

function finishTurn() {
  thinkingView = null
  thinkingBuf = ''
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
    thinkingBuf = C.gray('(思考) ') + text
    thinkingView = new Text(thinkingBuf, 1, 0)
    transcript.addChild(thinkingView)
  } else {
    thinkingBuf += text
    thinkingView.setText(thinkingBuf)
  }
  scrollToEnd()
  tui.requestRender()
}

// 服务端斜杠命令（走 JSON-RPC session/command）
const SERVER_COMMANDS = new Set(['compact', 'feedback', 'goal', 'export'])

// ---- 输入 ----
// 模型注册表：从运行时配置解析（core.loadModelsFromConfig）
let MODEL_LIST = []

function loadModels() {
  MODEL_LIST = loadModelsFromConfig(readFileSync(CONFIG, 'utf8'))
  if (MODEL_LIST.length === 0) {
    console.error(C.red(`读取模型配置失败或未发现模型：${CONFIG}`))
    MODEL_LIST = [{ id: MODEL, name: MODEL, provider: PROVIDER }]
  }
}

// 切换模型：按模型所在 route 选接口（responses/completions），重新 initialize，新会话生效
async function switchModel(modelId) {
  if (busy) {
    setStatus(C.yellow('对话进行中，等本轮结束再切换模型'))
    return
  }
  const found = MODEL_LIST.find(m => m.id === modelId)
  const route = found?.provider ?? PROVIDER
  if (modelId === stats.modelName && route === stats.providerName) return
  addUser(C.gray(`(切换模型: ${modelId} · ${route})`))
  try {
    await client.initialize({ cwd, provider: route, model: modelId })
  } catch (error) {
    addToolResult(C.red(`✗ 切换失败: ${error instanceof Error ? error.message : String(error)}`))
    return
  }
  stats.modelName = modelId
  stats.providerName = route
  newSession()
  renderStats()
  setStatus(`已切换模型: ${modelId} (${route})`)
}

const selectTheme = {
  selectedPrefix: text => C.cyan(text),
  selectedText: text => text,
  description: text => C.gray(text),
  scrollInfo: text => C.gray(text),
  noMatch: text => C.yellow(text),
}

// 模型选择器（overlay）
function showModelPicker() {
  const items = MODEL_LIST.map(m => {
    const iface = m.provider.includes('completions') ? 'completions' : 'responses'
    return {
      value: m.id,
      label: m.id,
      description: `${m.name} · ctx ${m.contextWindow ? fmtTokens(m.contextWindow) : '?'} · ${iface}`,
    }
  })
  const list = new SelectList(items, 10, selectTheme)
  list.onSelect = (item) => {
    tui.hideOverlay()
    void switchModel(item.value)
  }
  list.onCancel = () => tui.hideOverlay()
  tui.showOverlay(list)
}

function listModels() {
  const lines = MODEL_LIST.map(m => {
    const iface = m.provider.includes('completions') ? 'completions' : 'responses'
    const active = m.id === stats.modelName && m.provider === stats.providerName
    return `  ${active ? C.green('● ') : C.gray('  ')}${C.cyan(m.id)}  ${C.gray(m.name)}  ctx ${m.contextWindow ? fmtTokens(m.contextWindow) : '?'}  ${active ? C.gray('(当前)') : C.gray(`[${iface}]`)}`
  })
  addUser(`${C.bold('可用模型')} (${MODEL_LIST.length}):\n${lines.join('\n')}\n ${C.gray('输入 /model 打开选择器，或 /model <id> 直接切换')}`)
}

// 已知命令全集（服务端 + 自定义）
const ALL_COMMANDS = [...SERVER_COMMANDS, 'model', 'models', 'new', 'exit', 'quit'].sort((a, b) => b.length - a.length)

async function submit(text) {
  const t = fixCommand(text.trim(), ALL_COMMANDS)
  if (t === '') return
  // busy 时：斜杠命令仍可执行（命令不依赖 agent 空闲）；普通文本提示排队
  if (busy && !t.startsWith('/')) {
    addUser(C.yellow('(回答进行中，请等本轮完成后再发送)'))
    return
  }
  if (t === '/exit' || t === '/quit') {
    await shutdown()
    return
  }
  if (t === '/new') {
    newSession()
    addUser(`(新会话)`)
    setStatus(`会话: ${sessionId.slice(0, 20)}…`)
    return
  }
  if (t === '/model') {
    showModelPicker()
    return
  }
  if (t === '/models') {
    listModels()
    return
  }
  if (t.startsWith('/model ')) {
    const id = t.slice(7).trim()
    if (MODEL_LIST.some(m => m.id === id)) {
      void switchModel(id)
    } else {
      addUser(C.gray(`未知模型: ${id}（/models 查看可用模型）`))
    }
    return
  }
  // 服务端斜杠命令（JSON-RPC session/command）——busy 时也可执行
  const cmdName = t.slice(1).split(/\s+/)[0]
  if (SERVER_COMMANDS.has(cmdName)) {
    addUser(t)
    setStatus(`执行命令 ${t}…`)
    try {
      const r = await client.command(sessionId, t)
      if (r.executed) addToolResult(r.text !== undefined && r.text !== '' ? r.text : '✓ 命令完成')
      else addToolResult(C.red(`✗ ${r.text ?? '命令未解析'}`))
    } catch (error) {
      addToolResult(C.red(`✗ ${error instanceof Error ? error.message : String(error)}`))
    }
    setStatus('就绪')
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
    for (;;) {
      // 会话已切换：退出当前订阅循环，重建（tryNext 轮询保证及时检测）
      if (sid !== sessionId) break
      const n = sub.tryNext()
      if (n === undefined) {
        await new Promise(resolve => setTimeout(resolve, 40))
        continue
      }
      if (n.method !== 'session.event') continue
      const { sessionId: evSid, event } = n.params
      if (typeof evSid !== 'string' || evSid !== sid) continue
      if (event === null || typeof event !== 'object') continue
      const { type } = event
      const data = event.data ?? {}

      switch (type) {
        case 'turn/start':
          statsOnEvent(stats, event)
          break
        case 'step/start':
          statsOnEvent(stats, event)
          break
        case 'assistant/chunk': {
          const { chunk } = data
          statsOnEvent(stats, event)
          if (chunk && typeof chunk === 'object') {
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') appendAssistant(chunk.text)
            else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.trim() !== '') addThinkingLine(chunk.text)
          }
          break
        }
        case 'assistant/message': {
          statsOnEvent(stats, event)
          renderStats()
          break
        }
        case 'request/context': {
          statsOnEvent(stats, event)
          renderStats()
          break
        }
        case 'tool/call': {
          statsOnEvent(stats, event)
          const name = data.name ?? '?'
          let args = String(data.arguments ?? '')
          try { args = JSON.stringify(JSON.parse(args)) } catch { /* keep raw */ }
          if (args.length > 200) args = args.slice(0, 200) + '…'
          addToolCall(name, args)
          break
        }
        case 'tool/result': {
          if (statsOnEvent(stats, event)) renderStats()
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
loadModels()
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
