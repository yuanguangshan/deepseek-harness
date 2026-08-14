/**
 * dsh-repl TUI — pi-style interface: a top status strip, a scrolling transcript, and a bottom multi-line editor.
 *
 * Drives the dsh JSON-RPC runtime (a spawned subprocess) over @deepseek-ai/dsh-sdk-client and renders
 * with @earendil-works/pi-tui. The session-event → UI mapping lives in the pure {@link reduceSessionEvent};
 * this module owns only terminal glue (widgets, the subscription loop, input handlers, runtime restart).
 *
 * Commands:
 *   /new          start a fresh session (clears context)
 *   /resume       pick a historical session and continue it (a subscription-scoped session id)
 *   /pet          show the pet card (level/exp/mood); /pet pat pets the whale
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
  collapseToolText, COLLAPSE_HEAD_LINES, COLLAPSE_TAIL_LINES, createStats, fixCommand,
  formatModelTag, formatStatsLine, interactiveConfig, loadModelsFromConfig,
  nextToolCardVisibility, pickRoute, runtimeBin, fmtTokens, type ReplStats,
  type ToolCardVisibility,
} from './core.ts'
import { createReducerState, reduceSessionEvent, type ReplEffect, type ReplReducerState } from './session-reducer.ts'
import { fetchUsageSnapshot, formatUsageStatus, loadUsageProvidersFromDisk } from './usage.ts'
import {
  EXP_PER_TURN, addExp, formatPetCard, formatPetStatusLine, loadPetStatsFromDisk,
  savePetStatsToDisk, workingQuip, type PetMood, type PetStats,
} from './pet.ts'
import { describeSession, listSessions } from './history.ts'

const RUNTIME_BIN = runtimeBin()
const CONFIG = interactiveConfig()
const PROVIDER = process.env.DSH_REPL_PROVIDER ?? 'opencode-go'
const MODEL = process.env.DSH_REPL_MODEL ?? 'deepseek-v4-flash'

/**
 * Startup options for the REPL.
 * `resume` — when truthy (the default) the REPL opens directly on the most
 * recent historical session in the current workspace so the user can continue
 * it, instead of starting a blank session. The flag is accepted explicitly via
 * `--resume`; both paths behave identically because the REPL resumes by default.
 */
export interface RunReplOptions {
  readonly resume?: boolean
}

/** Run the TUI against the configured runtime until the user exits. */
export async function runRepl(options: RunReplOptions = {}): Promise<void> {
  if (!existsSync(RUNTIME_BIN) || !existsSync(CONFIG)) {
    console.error(C.red(`缺少运行时或配置：\n  ${RUNTIME_BIN}\n  ${CONFIG}\n请先 pnpm run build`))
    process.exit(1)
  }

  const cwd = process.cwd()

  // ---- ANSI colors (pi-theme semantics) ----
  // Single-line status bar: left metrics + middle API-usage/quota + right model tag, truncated (no wrap) when too long.
  class StatusBar {
    left = ''
    mid = ''
    right = ''
    invalidate(): void {}
    setText(left: string, right: string, mid = ''): void {
      this.left = left
      this.right = right
      this.mid = mid
    }
    render(width: number): string[] {
      const rw = visibleWidth(this.right)
      // Mid (quota) is clearly separated from the left stats block (its final segment is ctx).
      const mid = this.mid !== '' ? `  |  ${this.mid}  ` : ''
      const mw = visibleWidth(mid)
      const leftMax = Math.max(0, width - mw - rw - 2)
      const left = visibleWidth(this.left) > leftMax
        ? truncateToWidth(this.left, Math.max(0, leftMax - 1)) + '…'
        : this.left
      const pad = ' '.repeat(Math.max(1, width - visibleWidth(left) - mw - rw))
      return [left + mid + pad + this.right]
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
    { name: 'resume', description: '恢复历史会话' },
    { name: 'compact', description: '压缩当前会话上下文' },
    { name: 'feedback', description: '反馈' },
    { name: 'goal', description: '目标（/goal set <目标> 创建）' },
    { name: 'export', description: '导出会话' },
    { name: 'exit', description: '退出' },
    { name: 'quit', description: '退出' },
    { name: 'reload', description: '重载运行时配置（模型变更生效）' },
    { name: 'pet', description: '宠物卡片（/pet pat 拍一拍）' },
  ], cwd))
  const statusBar = new StatusBar()
  const status = new Text('', 0, 0)

  // ---- pet (小鲸娘): mood state machine + growth, animated on the status row ----
  const petStats: PetStats = loadPetStatsFromDisk()
  const petStyle = { gray: C.gray, cyan: C.cyan, green: C.green }
  let petMood: PetMood = 'idle'
  let petTick = 0
  let petTimer: ReturnType<typeof setInterval> | null = null
  let petLastActivity = Date.now()
  let petStatusOverride: string | null = null // one-shot celebration message, cleared after a few ticks
  let petOverrideTicks = 0
  /** Prompt for the pet card (transcript bubble) after the live status settles. */
  let petPendingCard = false
  const SLEEP_AFTER_MS = 3 * 60_000

  /** Persist pet growth after each stat change (best-effort). */
  const persistPet = (): void => { savePetStatsToDisk(petStats) }
  /** Animate the pet on the status row; the tick also expires a one-shot override message. */
  const renderPet = (): void => {
    if (petStatusOverride !== null) {
      petOverrideTicks -= 1
      if (petOverrideTicks <= 0) petStatusOverride = null
    }
    status.setText(formatPetStatusLine(petStats, petMood, petTick, petStyle, petStatusOverride ?? undefined))
    tui.requestRender()
  }
  const tickPet = (): void => {
    // Idle for too long → doze off; any activity (set below) wakes the pet.
    if (petMood === 'idle' && Date.now() - petLastActivity >= SLEEP_AFTER_MS) petMood = 'sleeping'
    // Transient moods decay back to idle after a couple of ticks.
    if ((petMood === 'happy' || petMood === 'sad') && Date.now() - petLastActivity >= 6_000) petMood = 'idle'
    petTick += 1
    renderPet()
    if (petPendingCard) {
      petPendingCard = false
      transcript.addChild(new Text(formatPetCard(petStats, petMood, Date.now(), petStyle).join('\n'), 1, 0))
      tui.requestRender()
    }
  }
  /** Wake + re-render in the given mood; called at every user/turn activity boundary. */
  const setPetMood = (mood: PetMood): void => {
    petLastActivity = Date.now()
    petMood = mood
    petTick = 0
    renderPet()
  }
  /** Show a one-shot celebration message over the mood bubble for a few ticks. */
  const petCelebrate = (message: string): void => {
    petStatusOverride = message
    petOverrideTicks = 3
    renderPet()
  }
  /** Grant turn exp; on level-up queue the pet card + celebration on the next tick. */
  const petTurnDone = (): void => {
    petStats.turns += 1
    const { stats, levelsGained } = addExp(petStats, EXP_PER_TURN)
    Object.assign(petStats, stats)
    persistPet()
    if (levelsGained > 0) {
      petCelebrate(`🎉 升级！${petStats.name} 升到 Lv.${petStats.level}`)
      petPendingCard = true
      petMood = 'happy'
    } else {
      setPetMood('happy')
    }
  }
  const startPetTimer = (): void => {
    if (petTimer === null) petTimer = setInterval(tickPet, 2_000)
  }
  /** Re-hand the status row to the animated pet after a transient plain-text status. */
  const resumePet = (): void => {
    renderPet()
    startPetTimer()
  }
  const stopPetTimer = (): void => {
    if (petTimer !== null) {
      clearInterval(petTimer)
      petTimer = null
    }
  }

  let whaleTimer: ReturnType<typeof setInterval> | null = null
  let whalePos = 0
  let whaleDir = 1
  let whaleMsg = workingQuip(0, 0)
  let whaleBounces = 0 // edge hits since the last quip change; two bounces = one full lap
  let whaleRound = 0
  let whaleSeed = 0

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
  /** Thinking indicator: the working-phase pet — a small whale swims across the status bar,
   *  changing its quip once per full lap. */
  const startWhale = (): void => {
    // A new seed each turn shuffles the quip order (7 stays coprime to the pool size).
    whaleSeed = (whaleSeed + 3) % 10
    whaleMsg = workingQuip(0, whaleSeed)
    stopWhale()
    stopPetTimer() // the swimming whale replaces the animated pet card for the duration of the turn
    whalePos = 0
    whaleDir = 1
    whaleBounces = 0
    whaleRound = 0
    whaleTimer = setInterval(() => {
      const width = terminal.columns
      const maxPos = Math.max(4, width - whaleMsg.length - 8)
      whalePos += whaleDir
      if (whalePos >= maxPos) { whalePos = maxPos; whaleDir = -1; whaleBounces += 1 }
      if (whalePos <= 0) { whalePos = 0; whaleDir = 1; whaleBounces += 1 }
      if (whaleBounces >= 2) {
        // One full lap completed: advance to the next quip.
        whaleBounces = 0
        whaleRound += 1
        whaleMsg = workingQuip(whaleRound, whaleSeed)
      }
      renderWhale()
    }, 160)
  }
  /** Hand the status row back to the pet (used after the working whale stops). */
  const setStatus = (text: string): void => {
    stopWhale()
    stopPetTimer()
    status.setText(text)
    tui.requestRender()
    if (text.includes('小鲸娘')) {
      // The idle greeting means the turn ended and the pet owns the row again.
      petLastActivity = Date.now()
      if (petMood === 'working' || petMood === 'sleeping') petMood = 'idle'
      renderPet()
      startPetTimer()
    }
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
      usageLine,
    )
    tui.requestRender()
  }

  // ---- API usage/quota (DeepSeek 余额 + opencode 用量), shown mid status bar ----
  const USAGE_REFRESH_MS = 60_000 // 重刷配额的最短间隔（防抖）
  let usageLine = ''
  let usageTimer: ReturnType<typeof setTimeout> | null = null
  let usageLastRefreshed = 0
  let usagePending = false
  const usageStyle: Parameters<typeof formatUsageStatus>[1] = { green: C.green, yellow: C.yellow, red: C.red, gray: C.gray }

  /** Refresh the quota snapshot from ~/.zcode/v2/config.json, throttled unless forced. */
  const refreshUsage = (force = false): void => {
    const now = Date.now()
    if (usagePending || (!force && now - usageLastRefreshed < USAGE_REFRESH_MS)) return
    usagePending = true
    usageLastRefreshed = now
    const providers = loadUsageProvidersFromDisk()
    void fetchUsageSnapshot(providers)
      .then((snapshot) => { usageLine = formatUsageStatus(snapshot, usageStyle) })
      .catch(() => { usageLine = '' })
      .finally(() => {
        usagePending = false
        renderStats()
      })
  }
  /** Stop the periodic quota refresh (called during shutdown). */
  const stopUsageRefresh = (): void => {
    if (usageTimer !== null) {
      clearTimeout(usageTimer)
      usageTimer = null
    }
  }
  /** Keep the quota fresh: periodic re-query plus an immediate load on startup. */
  const startUsageRefresh = (): void => {
    refreshUsage(true)
    usageTimer = setTimeout(() => {
      refreshUsage()
      startUsageRefresh() // re-arm for the next cycle
    }, USAGE_REFRESH_MS * 5)
  }

  // ---- message rendering ----
  let assistantView: Markdown | null = null
  let assistantBuf = ''

  /**
   * One tool (or command-result) card in the transcript. Instead of a single flat
   * `toolView`/`toolBuf` pair, each card keeps its own persistent pi-tui `Text` whose
   * content is swapped by the current visibility (all cards share one global state,
   * cycled with Ctrl+O, mirroring the removed upstream `@deepseek-ai/dsh-tui` design):
   * - `expanded` → full body,
   * - `collapsed` → head/tail preview,
   * - `hidden`    → empty (dropped from readability without touching Container children).
   */
  interface ToolCard {
    readonly id: number
    /** Full cumulative text: the `⚙ name(args)` header plus every appended result line. */
    body: string
    /** Persistent pi-tui Text; its text swaps with visibility. Kept even when hidden. */
    readonly view: Text
  }
  const cards: ToolCard[] = []
  /** The card the current turn is accumulating results into (null between/after turns). */
  let activeCard: ToolCard | null = null
  let cardSeq = 0
  let cardVisibility: ToolCardVisibility = 'collapsed'

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
  /** Re-render one card's text to match the shared visibility state. */
  const renderCard = (card: ToolCard): void => {
    const full = card.body
    switch (cardVisibility) {
      case 'expanded':
        card.view.setText(full)
        break
      case 'hidden':
        card.view.setText('') // lightweight hide: collapse the card to nothing
        break
      case 'collapsed': {
        // Reuse the structural collapse (head/tail by line); for a single long line
        // fall back to a per-render width truncation because line elision cannot help.
        if (full.split('\n').length > COLLAPSE_HEAD_LINES + COLLAPSE_TAIL_LINES + 1) {
          const preview = collapseToolText(full)
          card.view.setText(preview === undefined ? full : preview)
        } else {
          const first = full.split('\n')[0] ?? ''
          card.view.setText(truncateToWidth(first, Math.max(1, terminal.columns - 6), '…'))
        }
        break
      }
    }
    tui.requestRender()
  }

  /** Open a fresh tool card for a `tool/call`. */
  const addToolCall = (name: string, args: string): void => {
    cardSeq += 1
    const body = C.blue(`⚙ ${name}(${args})`)
    const card: ToolCard = { id: cardSeq, body, view: new Text('', 1, 0) }
    cards.push(card)
    activeCard = card
    transcript.addChild(card.view)
    renderCard(card)
  }

  /** Append a `tool/result` summary to the active card (or start a command-result card). */
  const addToolResult = (summary: string): void => {
    if (activeCard !== null) {
      activeCard.body += `\n  ${C.gray(`→ ${summary}`)}`
      renderCard(activeCard)
    } else {
      // No active card (e.g. a command result: /compact and friends bypass the
      // tool/call event): make a fresh `→ ...` card.
      cardSeq += 1
      const body = `  ${C.gray(`→ ${summary}`)}`
      const card: ToolCard = { id: cardSeq, body, view: new Text('', 1, 0) }
      cards.push(card)
      activeCard = card
      transcript.addChild(card.view)
      renderCard(card)
    }
  }

  /** Ctrl+O: cycle the shared tool-card visibility and re-render every card. */
  const cycleToolCardVisibility = (): void => {
    cardVisibility = nextToolCardVisibility(cardVisibility)
    for (const card of cards) renderCard(card)
    setStatus(`${C.cyan('工具卡')}：${C.gray(cardVisibility === 'hidden' ? '隐藏' : cardVisibility === 'expanded' ? '展开' : '折叠')}`)
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
    // Detach the active card so a later command result starts a fresh `→ ...` card,
    // but keep the finished card in `cards` so Ctrl+O still cycles historic cards.
    activeCard = null
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
  // Open directly on the most recent historical session of this workspace
  // (resume is the default; `--resume` makes it explicit) so the user continues
  // the previous conversation instead of starting blank. The runtime resumes the
  // id from disk via server-side `agents.resume`, so its persisted context is
  // loaded. A fresh uuid is the fallback when there is nothing to resume or
  // startup-resume is disabled.
  const initialSessions = options.resume !== false ? listSessions() : []
  let resumedStartupId: string | undefined
  let sessionId = `repl-${randomUUID()}`
  if (initialSessions.length > 0 && initialSessions[0] !== undefined) {
    sessionId = initialSessions[0].sessionId
    resumedStartupId = sessionId
  }
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
      resumePet()
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

  // ---- resume (continue a historical session) ----

  /**
   * Switch the REPL's target session to the given historical id and reset
   * turn-scoped state. The subscription loop notices the id change and rebuilds
   * on the new session; the next `client.prompt` then runs on that session,
   * whose persisted context the runtime loads from disk. Resetting the stats
   * and reducer state so the resumed turn starts from a clean slate.
   * @param id - a session id (from {@link listSessions} or a `/resume <id>` run).
   */
  const resumeTo = (id: string): void => {
    if (busy) {
      setStatus(C.yellow('对话进行中，等本轮结束再恢复会话'))
      return
    }
    if (id === sessionId) {
      setStatus(C.yellow(`已在会话 ${id.slice(0, 20)}… 中`))
      return
    }
    sessionId = id
    Object.assign(reducerState, createReducerState())
    Object.assign(stats, createStats(PROVIDER, MODEL))
    addUser(`(恢复会话 ${C.green(id.slice(0, 20))}…)`)
    setStatus(`已恢复会话，继续对话: ${id.slice(0, 20)}…`)
    resumePet()
  }

  /** Historical-session picker (overlay), newest first, current session marked. */
  const showResumePicker = (): void => {
    const sessions = listSessions()
    if (sessions.length === 0) {
      addUser(C.gray('没有找到历史会话（.sessions 目录无会话或 DSH_SESSION_ROOT 不可读）'))
      setTimeout(() => { resumePet() }, 0)
      return
    }
    const items = sessions.map(s => ({
      value: s.sessionId,
      label: s.sessionId.slice(0, 12) + '…',
      description: `${describeSession(s, { gray: C.gray, cyan: C.cyan, green: C.green, yellow: C.yellow })}${s.sessionId === sessionId ? C.green(' (当前)') : ''}${s.cwd !== undefined && s.cwd !== process.cwd() ? C.gray(` · ${s.cwd}`) : ''}`,
    }))
    const list = new SelectList(items, 10, selectTheme)
    list.onSelect = (item) => {
      tui.hideOverlay()
      resumeTo(item.value)
    }
    list.onCancel = () => { tui.hideOverlay() }
    tui.showOverlay(list)
  }

  /** Server-side slash commands (routed through the JSON-RPC session/command method). */
  const serverCommands = new Set(['compact', 'feedback', 'goal', 'export'])
  /** Known command set (server + custom), longest-first for fixCommand. */
  const allCommands = [...serverCommands, 'model', 'models', 'new', 'resume', 'pet', 'pet pat', 'exit', 'quit'].sort((a, b) => b.length - a.length)

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
      resumePet()
      return
    }
    if (t === '/resume') {
      showResumePicker()
      return
    }
    if (t.startsWith('/resume ')) {
      const id = t.slice(8).trim()
      if (id === '') {
        showResumePicker()
      } else {
        resumeTo(id)
      }
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
    if (t === '/pet') {
      transcript.addChild(new Text(formatPetCard(petStats, petMood, Date.now(), petStyle).join('\n'), 1, 0))
      tui.requestRender()
      return
    }
    if (t === '/pet pat') {
      petStats.pats += 1
      persistPet()
      petCelebrate('🎉 被拍了拍，很开心！')
      setPetMood('happy')
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
      resumePet()
      return
    }
    addUser(text)
    busy = true
    editor.disableSubmit = true // block all submissions until turn/end unlocks the editor
    setPetMood('working')
    startWhale()
    try {
      await client.prompt(sessionId, [{ type: 'text', text: t }])
    } catch (error) {
      addToolResult(`请求失败: ${error instanceof Error ? error.message : String(error)}`)
      setPetMood('sad')
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
          petTurnDone()
          setStatus('🐳小鲸娘在此恭候~')
          refreshUsage() // 每轮结束后(受 60s 防抖)刷新配额显示
        }
        if (effects.some(e => e.kind === 'abnormalTurnEnd' || e.kind === 'error')) {
          setPetMood('sad')
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
    stopPetTimer()
    stopUsageRefresh()
    persistPet()
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
        setPetMood('sad')
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
    if (matchesKey(data, 'ctrl+o')) {
      cycleToolCardVisibility()
      return { consume: true }
    }
    return undefined
  })

  const addWelcome = (): void => {
    const tag = C.green('yuanguangshan定制版')
    const tagCol = 34
    const padTo = (s: string, col: number): string => s + ' '.repeat(Math.max(0, col - visibleWidth(s)))
    const art = [
      padTo('                           ~  ~', tagCol) + tag,
      '     ╲╲            ╱ ╲     ~ ~',
      '        ╭────────────────────╮',
      '        │                 ●  │╴',
      '        │                  ▄▄│',
      '        │                    │',
      '        ╰────────────────────╱',
      '     ╱╱',
      '',
      `  ${C.bold('欢迎使用 DeepSeek Harness')}`,
      `  ${C.gray('────────────────────────────')}`,
      `  ${C.cyan(PROVIDER)} · ${C.green(MODEL)}`,
      `  输入问题开始对话 · ${C.gray('/new')} 新会话 · ${C.gray('/pet')} 宠物 · ${C.gray('/exit')} 退出`,
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
  if (resumedStartupId !== undefined) {
    addUser(`(已恢复最近会话 ${C.green(resumedStartupId.slice(0, 20))}…)`)
    setStatus(`已恢复会话，继续对话: ${resumedStartupId.slice(0, 20)}…`)
  } else {
    setStatus('🐳小鲸娘在此恭候~')
  }
  tui.start()
  startUsageRefresh()
  resumePet()
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
  // 44 = blue background, 37 = white foreground — keep the dark blue bubble but use white text for contrast.
  bubbleBg: (s: string): string => `\x1b[44;37m${s}\x1b[0m`,
}
