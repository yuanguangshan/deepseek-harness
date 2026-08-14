/**
 * dsh-repl TUI — pi-style interface: a top status strip, a scrolling transcript, and a bottom multi-line editor.
 *
 * Drives the dsh JSON-RPC runtime (a spawned subprocess) over @deepseek-ai/dsh-sdk-client and renders
 * with @earendil-works/pi-tui. The session-event → UI mapping lives in the pure {@link reduceSessionEvent};
 * this module owns only terminal glue (widgets, the subscription loop, input handlers, runtime restart).
 *
 * Commands:
 *   /new          start a fresh session (clears context)
 *   /exit, /quit  quit
 *   Ctrl+C        quit
 */
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import {
  CombinedAutocompleteProvider, Container, Editor, Markdown, ProcessTerminal, ScrollView,
  SelectList, Text, TuiAltScreen, VStack, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import {
  createStats, fixCommand, formatModelTag, formatStatsLine,
  interactiveConfig, loadModelsFromConfig, pickRoute, runtimeBin,
  fmtTokens, type ReplStats,
} from './core.ts'
import { createReducerState, reduceSessionEvent, type ReplEffect, type ReplReducerState } from './session-reducer.ts'

const RUNTIME_BIN = runtimeBin()
const CONFIG = interactiveConfig()
const PROVIDER = process.env.DSH_REPL_PROVIDER ?? 'opencode-go'
const MODEL = process.env.DSH_REPL_MODEL ?? 'deepseek-v4-flash'

/** Run the TUI against the configured runtime until the user exits. */
export async function runRepl(): Promise<void> {
  if (!existsSync(RUNTIME_BIN) || !existsSync(CONFIG)) {
    console.error(C.red(`缺少运行时或配置：\n  ${RUNTIME_BIN}\n  ${CONFIG}\n请先 pnpm run build`))
    process.exit(1)
  }

  const cwd = process.cwd()

  // ---- ANSI colors (pi-theme semantics) ----
  // Single-line status bar: left metrics + right model tag, truncated (no wrap) when too long.
  class StatusBar {
    left = ''
    right = ''
    invalidate(): void {}
    setText(left: string, right: string): void {
      this.left = left
      this.right = right
    }
    render(width: number): string[] {
      const rw = visibleWidth(this.right)
      const leftMax = Math.max(0, width - rw - 2)
      const left = visibleWidth(this.left) > leftMax
        ? truncateToWidth(this.left, Math.max(0, leftMax - 1)) + '…'
        : this.left
      const pad = ' '.repeat(Math.max(1, width - visibleWidth(left) - rw))
      return [left + pad + this.right]
    }
  }

  const terminal = new ProcessTerminal()
  // mouse: true enables mouse capture; wheelScrollLines sets how many rows each wheel notch scrolls
  // (the default 1 row is slow enough to feel broken).
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true, wheelScrollLines: 5 })

  const mdTheme = {
    heading: (text: string) => C.bold(C.cyan(text)),
    link: (text: string) => C.blue(text),
    linkUrl: (text: string) => C.gray(text),
    code: (text: string) => C.cyan(text),
    codeBlock: (text: string) => text,
    codeBlockBorder: (text: string) => C.gray(text),
    quote: (text: string) => C.gray(C.italic(text)),
    quoteBorder: (text: string) => C.gray(text),
    hr: (text: string) => C.gray(text),
    listBullet: (text: string) => C.blue(text),
    bold: (text: string) => C.bold(text),
    italic: (text: string) => C.italic(text),
    strikethrough: (text: string) => C.gray(text),
    underline: (text: string) => text,
  }
  const editorTheme = {
    borderColor: (text: string) => C.blue(text),
    selectList: {
      selectedPrefix: (text: string) => C.cyan(text),
      selectedText: (text: string) => text,
      description: (text: string) => C.gray(text),
      scrollInfo: (text: string) => C.gray(text),
      noMatch: (text: string) => C.yellow(text),
    },
  }

  const transcript = new Container()
  const scroll = new ScrollView(transcript, { follow: 'end', primary: true, overscroll: 'contain', scrollbar: 'auto' })
  // Scroll following trusts ScrollView's native follow: 'end': new content auto-follows while the
  // user is at the bottom; scrolling up to read history disables following; scrolling back to the
  // bottom re-enables it. No manual scrollToEnd fights the wheel.
  const editor = new Editor(tui, editorTheme)
  // Slash-command autocomplete + file-path completion (Tab).
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
    { name: 'reload', description: '重载运行时配置（模型变更生效）' },
  ], cwd))
  const statusBar = new StatusBar()
  const status = new Text('', 0, 0)

  let whaleTimer: ReturnType<typeof setInterval> | null = null
  let whalePos = 0
  let whaleDir = 1
  let whaleMsg = '思考中…'

  const stopWhale = (): void => {
    if (whaleTimer !== null) {
      clearInterval(whaleTimer)
      whaleTimer = null
    }
  }
  const renderWhale = (): void => {
    const width = terminal.columns
    const maxPos = Math.max(4, width - whaleMsg.length - 8)
    const pad = ' '.repeat(Math.min(whalePos, maxPos))
    status.setText(`${pad}🐳 ${whaleMsg}`)
    tui.requestRender()
  }
  /** Thinking indicator: a small whale swims back and forth across the status bar. */
  const startWhale = (msg = '思考中…'): void => {
    whaleMsg = msg
    stopWhale()
    whalePos = 0
    whaleDir = 1
    whaleTimer = setInterval(() => {
      const width = terminal.columns
      const maxPos = Math.max(4, width - whaleMsg.length - 8)
      whalePos += whaleDir
      if (whalePos >= maxPos) { whalePos = maxPos; whaleDir = -1 }
      if (whalePos <= 0) { whalePos = 0; whaleDir = 1 }
      renderWhale()
    }, 160)
  }
  const setStatus = (text: string): void => {
    stopWhale()
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

  // ---- session metrics (mirror the web StatsLine + ContextMeter) ----
  const stats: ReplStats = createStats(PROVIDER, MODEL)
  const renderStats = (): void => {
    statusBar.setText(
      formatStatsLine(stats, { gray: C.gray, cyan: C.cyan, green: C.green, yellow: C.yellow }) || C.gray('指标将在此显示'),
      formatModelTag(C.blue(stats.providerName), C.green(stats.modelName)),
    )
    tui.requestRender()
  }

  // ---- message rendering ----
  let assistantView: Markdown | null = null
  let assistantBuf = ''
  let toolView: Text | null = null
  let toolBuf = ''

  /** User-message bubble: blue background covers only the text (bubble style), not a full-width bar.
   *  Wraps to the rendered width and adapts to terminal resize, leaving a transparent right gap. */
  class UserBubble {
    readonly text: string
    readonly label: string
    readonly padX = 1
    constructor(text: string) {
      this.text = text
      this.label = C.bold(C.cyan('你'))
    }
    invalidate(): void {}
    render(width: number): string[] {
      const indent = 1
      const labelW = visibleWidth(this.label)
      const firstPrefixW = indent + labelW + 1
      const wrapW = Math.max(1, width - firstPrefixW - this.padX * 2)
      const lines: string[] = []
      const paragraphs = this.text.split('\n')
      for (let p = 0; p < paragraphs.length; p++) {
        const para = paragraphs[p] ?? ''
        if (para.trim() === '') {
          lines.push('')
          continue
        }
        const wrapped = wrapTextWithAnsi(para.replace(/\t/g, '   '), wrapW)
        for (let w = 0; w < wrapped.length; w++) {
          const cell = ' '.repeat(this.padX) + (wrapped[w] ?? '') + ' '.repeat(this.padX)
          const bubble = C.bubbleBg(cell) // color covers text + inner padding; reset precedes the right gap → transparent
          lines.push(w === 0 && p === 0
            ? ' '.repeat(indent) + this.label + ' ' + bubble
            : ' '.repeat(firstPrefixW) + bubble)
        }
      }
      return lines
    }
  }

  const addUser = (text: string): void => {
    transcript.addChild(new UserBubble(text))
    tui.requestRender()
  }
  const startAssistant = (): void => {
    assistantBuf = C.gray('🐳 ')
    assistantView = new Markdown('', 1, 0, mdTheme)
    transcript.addChild(assistantView)
    tui.requestRender()
  }
  const newAssistantBlock = (): void => {
    startAssistant()
  }
  const appendAssistant = (text: string): void => {
    if (assistantView === null) {
      startAssistant()
    }
    assistantBuf += text
  }
  /** Re-render the buffered assistant Markdown now (the reducer gates this to the flush cadence). */
  const flushAssistant = (): void => {
    if (assistantView !== null) {
      assistantView.setText(assistantBuf)
      tui.requestRender()
    }
  }
  const addThinkingLine = (text: string): void => {
    const view = new Text(C.gray('(思考) ') + text, 1, 0)
    transcript.addChild(view)
    tui.requestRender()
  }
  const addToolCall = (name: string, args: string): void => {
    toolBuf = `${C.blue(`⚙ ${name}(${args})`)}\n`
    toolView = new Text(toolBuf, 1, 0)
    transcript.addChild(toolView)
    tui.requestRender()
  }
  const addToolResult = (summary: string): void => {
    if (toolView !== null) {
      toolBuf += `  ${C.gray(`→ ${summary}`)}\n`
      toolView.setText(toolBuf)
    } else {
      // No toolView (e.g. a command result: /compact and friends bypass the tool/call event): make a fresh result card.
      toolBuf = `  ${C.gray(`→ ${summary}`)}\n`
      toolView = new Text(toolBuf, 1, 0)
      transcript.addChild(toolView)
    }
    tui.requestRender()
  }

  /** Apply the effects produced by the reducer to the terminal widgets. */
  const applyEffects = (effects: readonly ReplEffect[]): void => {
    for (const effect of effects) {
      switch (effect.kind) {
        case 'appendAssistant': appendAssistant(effect.text); break
        case 'appendThinking': addThinkingLine(effect.text); break
        case 'flushAssistant': flushAssistant(); break
        case 'newAssistantBlock': newAssistantBlock(); break
        case 'toolCall': addToolCall(effect.name, effect.args); break
        case 'toolResult': addToolResult(effect.summary); break
        case 'abnormalTurnEnd': addToolResult(C.red(`✗ turn 异常: ${JSON.stringify(effect.reason)}`)); break
        case 'renderStats': renderStats(); break
        case 'error': addToolResult(C.red(`✗ ${JSON.stringify(effect.data)}`)); break
        case 'finishTurn': break // handled below (turn bookkeeping)
      }
    }
  }
  const finishTurn = (): void => {
    assistantView = null
    assistantBuf = ''
    toolView = null
    toolBuf = ''
    busy = false
    editor.disableSubmit = false
    tui.requestRender()
  }
  const finishTurnFromEffects = (effects: readonly ReplEffect[]): void => {
    // finishTurn is applied after the visible effects so the reducer stays the single source of turn state.
    if (effects.some(e => e.kind === 'finishTurn')) finishTurn()
  }

  // ---- runtime ----
  let client = new HarnessClient({
    command: process.execPath,
    args: [RUNTIME_BIN, CONFIG],
    cwd,
    env: process.env,
  })
  let runtimeEpoch = 0 // bumped on every runtime restart; the subscription loop rebuilds on a change
  let sessionId = `repl-${randomUUID()}`
  let busy = false
  let shuttingDown = false
  // ESC interrupted the active turn; cleared when its turn/end arrives (avoids a double cancel).
  let interruptRequested = false
  const reducerState: ReplReducerState = createReducerState()

  const newSession = (): void => {
    sessionId = `repl-${randomUUID()}`
  }

  /** Teardown + respawn the runtime subprocess with new params, bumping the epoch so the subscription rebuilds.
   *  Used for both /model (switch route) and /reload (pick up config-file changes): one mechanism, since /reload
   *  must restart the process to re-read the config it loads at spawn. */
  const restartRuntime = async (opts: { provider: string; model: string; announce: string }): Promise<void> => {
    if (busy) {
      setStatus(C.yellow('对话进行中，等本轮结束再切换/重载'))
      return
    }
    addUser(C.gray(opts.announce))
    setStatus('重载中…')
    runtimeEpoch += 1
    try { await client.close() } catch { /* the old subprocess may already be gone */ }
    client = new HarnessClient({ command: process.execPath, args: [RUNTIME_BIN, CONFIG], cwd, env: process.env })
    client.start()
    try {
      await client.initialize({ cwd, provider: opts.provider, model: opts.model })
    } catch (error) {
      addToolResult(C.red(`✗ 失败: ${error instanceof Error ? error.message : String(error)}`))
      setStatus('失败')
      return
    }
    stats.providerName = opts.provider
    stats.modelName = opts.model
    loadModels()
    newSession()
    renderStats()
    setStatus('🐳小鲸娘在此恭候~')
  }

  // ---- model registry (parsed from the runtime config via core.loadModelsFromConfig) ----
  let modelList = loadModelsFromConfig(readFileSync(CONFIG, 'utf8'))
  const loadModels = (): void => {
    modelList = loadModelsFromConfig(readFileSync(CONFIG, 'utf8'))
    if (modelList.length === 0) {
      console.error(C.red(`读取模型配置失败或未发现模型：${CONFIG}`))
      modelList = [{ id: MODEL, name: MODEL, provider: PROVIDER, contextWindow: undefined, maxTokens: undefined }]
    }
  }
  loadModels()

  /** Switch the active model by its declaring route (responses/completions). */
  const switchModel = (modelId: string): Promise<void> => {
    if (busy) {
      setStatus(C.yellow('对话进行中，等本轮结束再切换模型'))
      return Promise.resolve()
    }
    const route = pickRoute(modelId, modelList, PROVIDER)
    if (modelId === stats.modelName && route === stats.providerName) return Promise.resolve()
    return restartRuntime({ provider: route, model: modelId, announce: `(切换模型: ${modelId} · ${route})` })
  }

  const selectTheme = {
    selectedPrefix: (text: string) => C.cyan(text),
    selectedText: (text: string) => text,
    description: (text: string) => C.gray(text),
    scrollInfo: (text: string) => C.gray(text),
    noMatch: (text: string) => C.yellow(text),
  }
  /** Model picker (overlay). */
  const showModelPicker = (): void => {
    const items = modelList.map((m) => {
      const iface = m.provider.includes('completions') ? 'completions' : 'responses'
      return {
        value: m.id,
        label: m.id,
        description: `${m.name} · ctx ${m.contextWindow !== undefined ? fmtTokens(m.contextWindow) : '?'} · ${iface}`,
      }
    })
    const list = new SelectList(items, 10, selectTheme)
    list.onSelect = (item) => {
      tui.hideOverlay()
      void switchModel(item.value)
    }
    list.onCancel = () => { tui.hideOverlay() }
    tui.showOverlay(list)
  }
  const listModels = (): void => {
    const lines = modelList.map((m) => {
      const iface = m.provider.includes('completions') ? 'completions' : 'responses'
      const active = m.id === stats.modelName && m.provider === stats.providerName
      return `  ${active ? C.green('● ') : C.gray('  ')}${C.cyan(m.id)}  ${C.gray(m.name)}  ctx ${m.contextWindow !== undefined ? fmtTokens(m.contextWindow) : '?'}  ${active ? C.gray('(当前)') : C.gray(`[${iface}]`)}`
    })
    addUser(`${C.bold('可用模型')} (${modelList.length}):\n${lines.join('\n')}\n ${C.gray('输入 /model 打开选择器，或 /model <id> 直接切换')}`)
  }

  /** Server-side slash commands (routed through the JSON-RPC session/command method). */
  const serverCommands = new Set(['compact', 'feedback', 'goal', 'export'])
  /** Known command set (server + custom), longest-first for fixCommand. */
  const allCommands = [...serverCommands, 'model', 'models', 'new', 'exit', 'quit'].sort((a, b) => b.length - a.length)

  const submitTurn = async (text: string): Promise<void> => {
    const t = fixCommand(text.trim(), allCommands)
    if (t === '') return
    if (t === '/exit' || t === '/quit') {
      shutdown()
      return
    }
    if (t === '/new') {
      newSession()
      addUser('(新会话)')
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
      if (modelList.some(m => m.id === id)) {
        void switchModel(id)
      } else {
        addUser(C.gray(`未知模型: ${id}（/models 查看可用模型）`))
      }
      return
    }
    if (t === '/reload') {
      void restartRuntime({ provider: stats.providerName, model: stats.modelName, announce: '(重载运行时… 模型配置变更生效)' })
      return
    }
    // Server-side slash command (JSON-RPC session/command) — the editor stays submit-disabled during a turn,
    // so these only run between turns.
    const cmdName = t.slice(1).split(/\s+/)[0] ?? ''
    if (serverCommands.has(cmdName)) {
      addUser(t)
      setStatus(`执行命令 ${t}…`)
      try {
        const r = await client.command(sessionId, t)
        if (r.executed) addToolResult(r.text !== undefined && r.text !== '' ? r.text : '✓ 命令完成')
        else addToolResult(C.red(`✗ ${r.text ?? '命令未解析'}`))
      } catch (error) {
        addToolResult(C.red(`✗ ${error instanceof Error ? error.message : String(error)}`))
      }
      setStatus('🐳小鲸娘在此恭候~')
      return
    }
    if (t.startsWith('/')) {
      addUser(`未知命令: ${t}`)
      return
    }
    addUser(text)
    busy = true
    editor.disableSubmit = true // block all submissions until turn/end unlocks the editor
    startWhale('思考中…')
    try {
      await client.prompt(sessionId, [{ type: 'text', text: t }])
    } catch (error) {
      addToolResult(`请求失败: ${error instanceof Error ? error.message : String(error)}`)
      finishTurn()
    }
  }
  editor.onSubmit = (text) => { void submitTurn(text) }

  // ---- subscription loop (started after client.start() by the startup block below) ----
  const runSubscription = async (): Promise<void> => {
    for (;;) {
      const sid = sessionId
      const epoch = runtimeEpoch
      const sub = client.subscribeSessionTree(sid)
      for (;;) {
        // session switched or runtime reloaded: leave this subscription loop and rebuild
        if (sid !== sessionId || epoch !== runtimeEpoch) break
        const n = sub.tryNext()
        if (n === undefined) {
          await new Promise(resolve => setTimeout(resolve, 40))
          continue
        }
        if (n.method !== 'session.event') continue
        const params = n.params as { sessionId?: unknown; event?: unknown }
        if (typeof params.sessionId !== 'string' || params.sessionId !== sid) continue
        if (params.event === null || typeof params.event !== 'object') continue
        const event = params.event as { type: string; time: number; data?: unknown }
        const effects = reduceSessionEvent(reducerState, event, stats)
        applyEffects(effects)
        finishTurnFromEffects(effects)
        if (effects.some(e => e.kind === 'finishTurn')) {
          renderStats()
          setStatus('🐳小鲸娘在此恭候~')
        }
      }
      if (sid === sessionId && epoch === runtimeEpoch) break
    }
  }

  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    // Step one: synchronously restore the terminal (raw mode, mouse, cursor) regardless of later cleanup.
    stopWhale()
    try {
      tui.stop()
    } catch { /* a restore failure must not strand the process on a raw terminal */ }
    // Step two: close the subprocess with a hard exit deadline so the process never hangs on a raw terminal.
    void (async () => {
      try {
        await Promise.race([
          client.close(),
          new Promise(resolve => setTimeout(resolve, 3_000)),
        ])
      } catch { /* ignore */ }
      process.exit(0)
    })()
  }

  // ESC interrupts streaming output during a turn; when idle it falls through to the editor (e.g. cancel autocomplete).
  // Ctrl+C quits.
  tui.addInputListener((data) => {
    if (matchesKey(data, 'escape')) {
      if (busy && !interruptRequested) {
        interruptRequested = true
        reducerState.interruptRequested = true
        setStatus(C.yellow('中断中…'))
        void client.cancel(sessionId).catch(() => {
          interruptRequested = false
          setStatus('🐳小鲸娘在此恭候~')
        })
        return { consume: true }
      }
      // idle / editor-focused: do not consume; let the editor handle escape.
      return undefined
    }
    if (matchesKey(data, 'ctrl+c')) {
      shutdown()
      return { consume: true }
    }
    return undefined
  })

  const addWelcome = (): void => {
    const tag = C.green('yuanguangshan定制版')
    const tagCol = 34
    const padTo = (s: string, col: number): string => s + ' '.repeat(Math.max(0, col - visibleWidth(s)))
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
    transcript.addChild(new Text(art, 1, 0))
    tui.requestRender()
  }

  client.start()
  try {
    await client.initialize({ cwd, provider: PROVIDER, model: MODEL })
  } catch (error) {
    tui.stop()
    console.error(C.red(`初始化失败: ${error instanceof Error ? error.message : String(error)}`))
    process.exit(1)
  }
  addWelcome()
  setStatus('🐳小鲸娘在此恭候~')
  tui.start()
  // The subscription must be created after client.start() to receive the event stream.
  void runSubscription().catch((error: unknown) => {
    if (shuttingDown) process.exit(0)
    try { tui.stop() } catch { /* ignore */ }
    console.error(C.red(`订阅终止: ${error instanceof Error ? error.message : String(error)}`))
    process.exit(1)
  })
}

// ---- colors (ANSI, pi-theme semantics) ----
const C = {
  blue: (s: string): string => `\x1b[34m${s}\x1b[0m`,
  cyan: (s: string): string => `\x1b[36m${s}\x1b[0m`,
  gray: (s: string): string => `\x1b[90m${s}\x1b[0m`,
  green: (s: string): string => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string): string => `\x1b[33m${s}\x1b[0m`,
  red: (s: string): string => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string): string => `\x1b[1m${s}\x1b[0m`,
  italic: (s: string): string => `\x1b[3m${s}\x1b[0m`,
  // user-bubble background: color only the text content (see UserBubble), not a full-width dark-blue bar.
  bubbleBg: (s: string): string => `\x1b[44m${s}\x1b[0m`,
}
