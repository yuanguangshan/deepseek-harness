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
 *   /tts <文本>    read text aloud (Edge TTS + local player)
 *   /tts on|off   toggle auto read-aloud of finished replies
 *   /pet          show the pet card (level/exp/mood); /pet pat pets the whale
 *   /exit, /quit  quit
 *   Ctrl+C        quit
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import {
  Container, Editor, Markdown, ProcessTerminal, ScrollView,
  Text, TuiAltScreen, VStack, isKeyRelease, matchesKey, truncateToWidth,
  visibleWidth, wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import {
  bracketScrollAction, collapseToolText, COLLAPSE_HEAD_LINES, COLLAPSE_TAIL_LINES, contextPressure, copyPayload,
  createStats, fetchGatewayModels,
  fetchModelCredits, fixCommand,
  formatHelp, formatModelTag, formatStatsFields, formatTurnBanter, formatTurnCost, editorCommandArgv,
  interactiveConfig, isCtrlG, KITTY_CSI_U, livePhaseText, loadModelsFromConfig,
  loadPromptHistoryFromDisk, nextToolCardVisibility, PAGE_SCROLL_OVERLAP_LINES, PASTE_COALESCE_MS, pickRoute,
  PROMPT_HISTORY_MAX, PROMPT_HISTORY_REPLAY, promptHistoryPath, runtimeBin, fmtTokens, savePromptHistoryToDisk, shouldCoalesceSubmit,
  TOOL_CARD_LABEL,
  type HelpCommandEntry, type ReplStats, type ToolCardVisibility, type TurnDelta,
} from './core.ts'
import { createReducerState, reduceSessionEvent, type ReplEffect, type ReplReducerState, type TodoView, type GoalView } from './session-reducer.ts'
import { fetchUsageSnapshot, formatUsageStatus, loadUsageProvidersFromDisk } from '@deepseek-ai/dsh-usage'
import {
  EXP_PER_TURN, addExp, formatPetCard, formatPetStatusLine, liveThinkingQuip, loadPetStatsFromDisk,
  savePetStatsToDisk, stepPetMood, welcomeBackMessage, workingQuip, type PetMood, type PetStats,
} from './pet.ts'
import { renderWhaleHalfBlock, stepWhaleSwim, type WhaleSwim } from './whale-banner.ts'
import { sendToWechat } from './weixin.ts'
import { describeSession, deleteSessionDir, listAllSessions, listSessions, readSessionEvents, userMessageText } from './history.ts'
import { estimateContextBreakdown, formatContextBreakdown } from './context-estimate.ts'
import { formatSessionCost } from './session-cost.ts'
import { formatBangResult, formatBangUsage, parseBangCommand, runShellCommand } from './bang.ts'
import { formatMacroList, loadMacros, removeMacro, resolveMacro, upsertMacro } from './macro.ts'
import { defaultSkillRoots, formatSkillCatalog, scanSkillCatalog } from './skills-list.ts'
import { shouldNotifyTurnComplete, sendSystemNotification } from './notify.ts'
import { clipboardImageTo } from './clipboard-image.ts'
import { searchableLines } from './fuzzy-search.ts'
import { formatAgentsPanel, recordSubagentNotification, type AgentRunEntry } from './agents-panel.ts'
/** One runtime-stored image ready to ride the next prompt (ref from session/attach). */
type PendingImage = Awaited<ReturnType<HarnessClient['attachImages']>>['attachments'][number]
import { AtFileProvider, extractImageMentions } from './atfile.ts'
import { ConfirmDialog, FilterPickerDialog, type PickerItem } from './picker.ts'
import { copyTextToClipboard } from './clipboard-copy.ts'
import { revertUnstaged, workspaceDiff } from './git-ops.ts'
import { formatDoctorReport, runDoctorChecks } from './doctor.ts'
import { StatusBar } from './status-bar.ts'
import { runText2Card } from './text2card.ts'
import { MemoryStore, gitBranch, memoryDir, renderMemorySnapshot } from '@deepseek-ai/dsh-memory'
import { cleanSpokenText, speak } from './tts.ts'

const RUNTIME_BIN = runtimeBin()
const CONFIG = interactiveConfig()
/** True when RUNTIME_BIN is a bare command name to resolve from PATH, not a file path. */
const isPathCommand = !RUNTIME_BIN.includes('/') && !RUNTIME_BIN.includes('\\')

/**
 * How to spawn the agent runtime: a file path is run under the current Node
 * (`node <runtime> <config>`), while a PATH command name is spawned directly
 * (its own shebang drives it). Either way the cordis config is the single arg.
 */
const LAUNCH = isPathCommand
  ? { command: RUNTIME_BIN, args: [CONFIG] }
  : { command: process.execPath, args: [RUNTIME_BIN, CONFIG] }
const PROVIDER = process.env.DSH_REPL_PROVIDER ?? 'ccswitch'
const MODEL = process.env.DSH_REPL_MODEL ?? 'glm-5.3-flash'
/** wb-proxy catalog endpoint serving billing multipliers for the tencent route. */
const CREDITS_URL = process.env.DSH_REPL_CREDITS_URL ?? 'http://127.0.0.1:8487/v1/models'
/** Short machine label for the status-bar right tag (first hostname path segment). */
const hostLabel = hostname().split('.')[0] || 'this-host'

/**
 * Startup options for the REPL.
 * `resume` — when truthy/open the REPL opens directly on a historical session
 * so the user can continue it, instead of starting a blank session:
 *  - `true`: the most recent session in the current workspace (the default
 *    behavior; the `--resume` flag requests it explicitly);
 *  - a string: that exact session id, from any workspace (`--resume <id>`).
 * `cwd` — launch the REPL bound to a different workspace than the caller's
 * current directory (`--cwd <dir>`). The process re-binds to `<dir>` so the
 * runtime, filesystem, and shell tools all resolve against that workspace.
 * This is what a cross-workspace `/resume` handoff uses to re-enter a session
 * in the directory it was created in.
 */
export interface RunReplOptions {
  readonly resume?: boolean | string
  readonly cwd?: string
}

/** Run the TUI against the configured runtime until the user exits. */
export async function runRepl(options: RunReplOptions = {}): Promise<void> {
  // In a standalone install the agent runtime is installed by the user and
  // reached via DSH_REPL_RUNTIME / DSH_REPL_CONFIG; in the monorepo it is the
  // built artifact. `isPathCommand` (module-level) distinguishes a PATH
  // command from a file path so the launch request spawns the right thing.
  const runtimeMissing = !isPathCommand && !existsSync(RUNTIME_BIN)
  if (runtimeMissing || !existsSync(CONFIG)) {
    console.error(C.red(`缺少 agent 运行时或配置：\n  运行时: ${RUNTIME_BIN}\n  配置:   ${CONFIG}`))
    if (runtimeMissing) {
      console.error(C.red(
        '独立安装场景：请先在目标机器安装 agent 运行时，再通过环境变量指向它：\n' +
        '  DSH_REPL_RUNTIME=<dsh-jsonrpc-agent 的 JS 入口绝对路径>\n  DSH_REPL_CONFIG=<你的 interactive.cordis.yml 路径>\n' +
        '仓库内开发场景：请先 pnpm run build',
      ))
    } else {
      console.error(C.red('请通过 DSH_REPL_CONFIG 指定已安装的 cordis 配置。'))
    }
    process.exit(1)
  }

  // Cross-workspace handoff re-launches this REPL in the target workspace
  // (`--cwd`), so `process.cwd()` must already be that directory *before* the
  // runtime spawns — the runtime and all path-resolving tools inherit it.
  if (options.cwd !== undefined && options.cwd !== process.cwd()) {
    try {
      process.chdir(options.cwd)
    } catch {
      console.error(C.red(`无法进入工作区: ${options.cwd}`))
      process.exit(1)
    }
  }
  const cwd = process.cwd()

  // ---- widgets ----
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
  // One select-list theme shared by the editor's autocomplete and every
  // FilterPickerDialog overlay (model / resume / memory edit).
  const selectTheme = {
    selectedPrefix: (text: string) => C.cyan(text),
    selectedText: (text: string) => text,
    description: (text: string) => C.gray(text),
    scrollInfo: (text: string) => C.gray(text),
    noMatch: (text: string) => C.yellow(text),
  }
  const editorTheme = {
    borderColor: (text: string) => C.blue(text),
    selectList: selectTheme,
  }

  const transcript = new Container()
  const scroll = new ScrollView(transcript, { follow: 'end', primary: true, overscroll: 'contain', scrollbar: 'auto' })
  // Scroll following trusts ScrollView's native follow: 'end': new content auto-follows while the
  // user is at the bottom; scrolling up to read history disables following; scrolling back to the
  // bottom re-enables it. No manual scrollToEnd fights the wheel.
  const editor = new Editor(tui, editorTheme)
  // `/command` completion entries — also the source of truth for /help.
  const commandCompletions: readonly HelpCommandEntry[] = [
    { value: 'help', description: '显示本帮助' },
    { value: 'model', description: '切换模型（选择器）' },
    { value: 'models', description: '列出可用模型' },
    { value: 'new', description: '新会话（清空上下文）' },
    { value: 'resume', description: '恢复历史会话' },
    { value: 'compact', description: '压缩当前会话上下文' },
    { value: 'feedback', description: '反馈' },
    { value: 'goal', description: '目标（/goal set <目标> 创建）' },
    { value: 'export', description: '导出会话' },
    { value: 'web-status', description: 'dsh web 运行状态（/web-status）' },
    { value: 'web-start', description: '启动 dsh web（/web-start）' },
    { value: 'web-stop', description: '停止 dsh web（/web-stop）' },
    { value: 'web-restart', description: '重启 dsh web（/web-restart）' },
    { value: 'web-switch', description: '无缝切到 TUI（/web-switch）' },
    { value: 'tui-status', description: 'TUI 会话状态（/tui-status）' },
    { value: 'tui-start', description: '打开 TUI 终端（/tui-start）' },
    { value: 'tui-stop', description: '退出 TUI（/tui-stop）' },
    { value: 'tui-restart', description: '重启 TUI（/tui-restart）' },
    { value: 'tui-switch', description: '无缝切到 Web（/tui-switch）' },
    { value: 'exit', description: '退出' },
    { value: 'quit', description: '退出' },
    { value: 'reload', description: '重载运行时配置（模型变更生效）' },
    { value: 'pet', description: '宠物卡片（/pet pat 拍一拍）' },
    { value: 'memory', description: '长期记忆（/memory remember <事实> 记一条 · /memory edit 删条目）' },
    { value: 'tts', description: '朗读：/tts <文本> 朗读 /tts on|off 自动朗读 /tts status 状态' },
    { value: 'tts on', description: '开启每回合结束自动朗读' },
    { value: 'tts off', description: '关闭自动朗读' },
    { value: 'tts status', description: '查看自动朗读状态' },
    { value: 'weixin', description: '发微信：/weixin 发最后回答 /weixin <文本> 指定文本 (/wx 同)' },
    { value: 'wx', description: '发微信：同 /weixin' },
    { value: 'text2card', description: '一句话生成手绘图文卡片：/text2card <一句话>' },
    { value: 'context', description: '上下文构成估算（chars/4 粗估 + 压缩提示）' },
    { value: 'cost', description: '会话 token/费用汇总（列表价估算）' },
    { value: 'copy', description: '复制最后回答（首个代码块优先）到系统剪贴板（Ctrl+Y 同）' },
    { value: 'diff', description: '查看工作区未提交改动（git diff 红绿渲染）' },
    { value: 'revert', description: '撤销全部未暂存改动（git checkout -- .，需确认）' },
    { value: 'doctor', description: '环境自检（runtime/剪贴板/TTS/微信/git/会话存储）' },
    { value: 'rename', description: '重命名当前会话（/rename <标题>，服务器命令）' },
    { value: 'skills', description: '列出可见技能（项目/用户目录）' },
    { value: 'agents', description: '后台代理运行记录' },
    { value: 'macro', description: '宏：/macro add <名> <文本> · /<名> 展开 · /macro rm <名>' },
    { value: 'search', description: '跨会话搜索历史消息（ctrl+r 同）' },
  ]
  editor.setAutocompleteProvider(new AtFileProvider(
    commandCompletions.map(c => ({ value: c.value, label: c.value, description: c.description })),
    cwd,
  ))
  const statusBar = new StatusBar()
  const status = new Text('', 0, 0)

  // ---- prompt history persistence (up/down arrows survive restarts) ----
  // Disk keeps the newest PROMPT_HISTORY_MAX entries (oldest → newest); the editor
  // replays only the newest PROMPT_HISTORY_REPLAY to match pi-tui's internal cap.
  const promptHistoryFile = promptHistoryPath()
  const promptHistory: string[] = loadPromptHistoryFromDisk(promptHistoryFile)
  for (let i = promptHistory.length - PROMPT_HISTORY_REPLAY; i < promptHistory.length; i++) {
    const entry = promptHistory[i]
    if (entry !== undefined && entry !== '') editor.addToHistory(entry)
  }
  /** Record a submitted text in the in-memory history and persist it best-effort. */
  const rememberPromptHistory = (text: string): void => {
    const trimmed = text.trim()
    if (trimmed === '') return
    const existing = promptHistory.lastIndexOf(trimmed)
    if (existing >= 0) promptHistory.splice(existing, 1)
    promptHistory.push(trimmed)
    if (promptHistory.length > PROMPT_HISTORY_MAX) promptHistory.splice(0, promptHistory.length - PROMPT_HISTORY_MAX)
    savePromptHistoryToDisk(promptHistory, promptHistoryFile)
  }

  // ---- todo / goal progress (bottom status-line strip) ----
  // The model's `todo_write` and goal changes arrive as `todo/write` and
  // `goal/change` session events; we surface them on a dedicated bottom line so
  // the user always sees which task is live and how the active goal is pacing.
  const MAX_TODO_ROWS = 3
  const todosView = new Text('', 0, 0)
  let latestTodos: readonly TodoView[] = []
  let latestGoal: GoalView | undefined
  let latestGoalRounds = 0
  const renderTodoBar = (): void => {
    const keep = latestTodos.filter(t => t.status !== 'completed')
    const done = latestTodos.length - keep.length
    const visible = keep.slice(0, MAX_TODO_ROWS)
    const hidden = keep.length - visible.length
    const pieces: string[] = []
    if (latestGoal !== undefined && latestGoal.objective !== '') {
      const phase = latestGoal.phase
      const progress = latestGoal.maxGoalRounds !== undefined
        ? `${latestGoalRounds}/${latestGoal.maxGoalRounds}` : ''
      const blocked = latestGoal.blockedReason !== undefined
        ? C.red(` 受阻: ${latestGoal.blockedReason}`) : ''
      pieces.push(`🎯 ${C.cyan(latestGoal.objective)}${progress !== '' ? `  [${progress}]` : ''}${phase !== '' && phase !== 'active' ? `  ${C.gray(`(${phase})`)}` : ''}${blocked}`)
    }
    if (visible.length === 0 && done === 0 && pieces.length === 0) {
      todosView.setText('')
      return
    }
    for (const todo of visible) {
      const glyph = todo.status === 'in_progress' ? C.green('▸') : '·'
      const dim = todo.status === 'completed' ? C.gray : ((s: string) => s)
      pieces.push(`${glyph} ${dim(todo.content)}`)
    }
    if (hidden > 0) pieces.push(C.gray(`… 还有 ${hidden} 项待办`))
    if (done > 0) pieces.push(C.gray(`✓ 已完成 ${done} 项`))
    todosView.setText(pieces.join('\n'))
    tui.requestRender()
  }

  // ---- long-term memory (five tracks, cross-session / cross-project globals) ----
  const memory = new MemoryStore({ dir: memoryDir() })

  // ---- 宏 / 待发图片附件 / 后台代理记录 / 回合计时 ----
  const macroStorePath = join(memoryDir(), 'macros.json')
  let pendingImages: PendingImage[] = []
  let subagentRuns: AgentRunEntry[] = []
  let turnStartedAt = 0
  /** Whether the one-shot context-pressure warning already fired for this session window. */
  let contextWarned = false
  /** The workspace git branch (lazily resolved) for the injected branch hint. */
  const memoryBranch = gitBranch(cwd)
  /** Build the memory snapshot block to prepend to the next prompt, or ''. */
  const memorySnapshot = (): string =>
    renderMemorySnapshot({
      memory: memory.entriesOf('memory'),
      user: memory.entriesOf('user'),
      key: memory.entriesOf('key', cwd),
      branch: memoryBranch,
    })
  /** The raw user prompt of the most recent turn, for the auto project/daily log. */
  let lastPromptSent = ''

  // ---- text-to-speech ----
  /** Auto read-aloud of finished assistant replies is off until enabled with /tts on. */
  let autoSpeak = false
  /** Serialize synthesis+playback so replies never talk over one another. */
  let speakChain: Promise<unknown> = Promise.resolve()
  /** Speak a piece of text (chained, non-blocking); errors surface as a tool result. */
  const speakBuffered = (text: string): void => {
    const clean = cleanSpokenText(text)
    if (clean === '') return
    speakChain = speakChain.then(() => speak(clean)).catch((error: unknown) => {
      addToolResult(`朗读失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }
  const defaultSpeakText = (): string => assistantBuf !== '' ? assistantBuf : lastPromptSent
  /**
   * The last completed assistant reply, captured at every turn end (before the
   * buffer clears) so /copy and Ctrl+Y work at any later time — the live
   * buffer only exists mid-reply and after a session switch it is empty.
   */
  let lastAssistantText = ''

  /**
   * Handle the `/memory` command family:
   *   /memory               → show the memory snapshot (what would be injected).
   *   /memory remember <t>  → add a long-term memory entry.
   *   /memory user <t>      → add a user-profile entry.
   *   /memory key <t>       → add a project key entry (branch-scoped).
   *   /memory project <t>   → add a project log entry.
   *   /memory clear <track> → remove all entries of a track (or 'all').
   */
  /**
   * /memory edit — interactive deletion panel over the three injected tracks
   * (memory / user / key). Enter deletes the highlighted entry (MemoryStore.remove
   * by exact text), then reopens so several entries can be cleaned in one go.
   */
  const showMemoryEditor = (): void => {
    const tracks: ReadonlyArray<{ target: 'memory' | 'user' | 'key'; label: string }> = [
      { target: 'memory', label: '长期记忆' },
      { target: 'user', label: '用户档案' },
      { target: 'key', label: '项目关键' },
    ]
    const items: PickerItem[] = []
    for (const { target, label } of tracks) {
      for (const entry of memory.entriesOf(target, cwd)) {
        items.push({ value: `${target}\u0000${entry}`, label: entry.length > 64 ? `${entry.slice(0, 63)}…` : entry, description: label })
      }
    }
    if (items.length === 0) {
      addToolResult(C.gray('注入轨道都是空的（/memory remember <事实> 先记一条）'))
      return
    }
    const dialog = new FilterPickerDialog(
      items,
      undefined,
      12,
      selectTheme,
      (item) => {
        const sep = item.value.indexOf('\u0000')
        const target = (sep > 0 ? item.value.slice(0, sep) : 'memory') as 'memory' | 'user' | 'key'
        const entry = sep > 0 ? item.value.slice(sep + 1) : item.value
        memory.remove(target, entry, target === 'key' ? cwd : undefined)
        addToolResult(`✓ 已删除一条${item.description}`)
        showMemoryEditor()
      },
      () => { tui.hideOverlay() },
      '\x1b[90m /memory edit 搜索过滤 · 回车删除该条 · Esc 清空/退出\x1b[0m',
    )
    tui.showOverlay(dialog)
  }

  const memoryCommand = (raw: string): void => {
    const args = raw.slice('/memory'.length).trim()
    if (args === 'edit') {
      showMemoryEditor()
      return
    }
    const spaceIdx = args.indexOf(' ')
    if (args === '' || spaceIdx < 0) {
      const snapshot = memorySnapshot()
      addUser(
        `长期记忆：\n${snapshot !== '' ? snapshot : C.gray('（当前没有记忆。用 /memory remember <事实> 记一条长期记忆，以后跨会话都会注入。）')}\n\n${C.gray('/memory remember <事实> · /memory user <档案> · /memory key <项目关键> · /memory project <日志> · /memory edit 删条目 · /memory clear <all|memory|user|key|project|daily>')}`,
      )
      return
    }
    const verb = args.slice(0, spaceIdx).toLowerCase()
    const text = args.slice(spaceIdx + 1).trim()
    switch (verb) {
      case 'remember':
        memory.add('memory', text)
        addToolResult(`✓ 已记入长期记忆（跨会话有效）: ${text}`)
        break
      case 'user':
        memory.add('user', text)
        addToolResult(`✓ 已记入用户档案: ${text}`)
        break
      case 'key':
        memory.add('key', text, cwd)
        addToolResult(`✓ 已记入项目关键记忆${memoryBranch !== undefined ? `（分支 ${memoryBranch}）` : ''}`)
        break
      case 'project':
        memory.add('project', text, cwd)
        addToolResult('✓ 已记入项目日志')
        break
      case 'daily':
        memory.add('daily', text, cwd)
        addToolResult('✓ 已记入今日日志')
        break
      case 'clear': {
        const target = text || 'all'
        const targets = (target === 'all' ? ['memory', 'user', 'key', 'project', 'daily'] : [target]) as Array<'memory' | 'user' | 'key' | 'project' | 'daily'>
        for (const t2 of targets) memory.clear(t2, cwd)
        addToolResult(`✓ 已清空: ${target}`)
        break
      }
      case 'edit':
        showMemoryEditor()
        break
      default:
        addUser(C.gray(`未知子命令: ${verb}`))
    }
  }

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

  /** Persist pet growth after each stat change (best-effort); also refreshes the
   *  last-seen stamp, so pet.json always remembers the latest encounter. */
  const persistPet = (): void => {
    petStats.lastSeenAt = Date.now()
    savePetStatsToDisk(petStats)
  }
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
    // The decay rule (idle → dozing, transient moods → idle) lives in pet.ts as a
    // pure step function; any activity (setPetMood below) refreshes the stamp.
    petMood = stepPetMood(petMood, petLastActivity, Date.now())
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
  // Memory continuity: greet a returning user once on startup, then stamp this encounter.
  const welcomeBack = welcomeBackMessage(petStats.lastSeenAt, Date.now())
  petStats.lastSeenAt = Date.now()
  persistPet()
  if (welcomeBack !== null) {
    petStatusOverride = welcomeBack
    petOverrideTicks = 5 // ~10s on the 2s tick before the mood bubble takes back over
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

  // The swim is one explicit state object (whale-banner.ts owns the pure step
  // function); the glue only owns the timer and the render.
  let whaleTimer: ReturnType<typeof setInterval> | null = null
  let whaleSeed = 0
  let whaleSwim: WhaleSwim = { pos: 0, dir: 1, bounces: 0, round: 0, msg: workingQuip(0, 0), liveThinking: null }

  const stopWhale = (): void => {
    if (whaleTimer !== null) {
      clearInterval(whaleTimer)
      whaleTimer = null
    }
  }
  const renderWhale = (): void => {
    const width = terminal.columns
    // Positions measured in visible width; the full line is clamped to `width` so
    // the swimming whale never wraps onto a second line on a narrow terminal.
    const maxPos = Math.max(0, width - visibleWidth(whaleSwim.msg) - 3) // 3 ≈ "🐳 "
    const pad = ' '.repeat(Math.min(whaleSwim.pos, maxPos))
    status.setText(truncateToWidth(`${pad}🐳 ${whaleSwim.msg}`, Math.max(1, width)))
    tui.requestRender()
  }
  /** Thinking indicator: the working-phase pet — a small whale swims across the status bar,
   *  changing its quip once per full lap. */
  const startWhale = (): void => {
    // A new seed each turn shuffles the quip order (7 stays coprime to the pool size).
    whaleSeed = (whaleSeed + 3) % 10
    stopWhale()
    stopPetTimer() // the swimming whale replaces the animated pet card for the duration of the turn
    whaleSwim = { pos: 0, dir: 1, bounces: 0, round: 0, msg: workingQuip(0, whaleSeed), liveThinking: null }
    whaleTimer = setInterval(() => {
      // WorkBuddy-style: while the model is thinking out loud, the whale repeats its
      // real thought; the canned pool only fills the quiet (tool-running) stretches.
      whaleSwim = stepWhaleSwim(whaleSwim, terminal.columns, round => workingQuip(round, whaleSeed))
      renderWhale()
    }, 160)
  }
  /** The idle greeting shown whenever no turn is running. */
  const IDLE_STATUS_TEXT = C.cyan('🐳小鲸娘在此恭候~')
  /**
   * Hand the status row to a plain-text message: the working whale and the pet
   * timer both stop, and the caller decides when the pet resumes
   * ({@link showIdleStatus} on turn end, or an explicit resume).
   */
  const setStatus = (text: string): void => {
    stopWhale()
    stopPetTimer()
    status.setText(text)
    tui.requestRender()
  }
  /** The idle greeting: the turn ended and the pet owns the status row again. */
  const showIdleStatus = (): void => {
    setStatus(IDLE_STATUS_TEXT)
    petLastActivity = Date.now()
    if (petMood === 'working' || petMood === 'sleeping') petMood = 'idle'
    renderPet()
    startPetTimer()
  }

  // 思考预览：固定在底部的浮动区域，显示最新三行思考内容（Text('') 渲染为 [] 不占行）
  const thinkingPreview = new Text('', 0, 0)

  tui.setLayoutRoot(new VStack([
    {
      component: new Text(` ygs  ${C.gray(`· ${PROVIDER} / ${MODEL}`)}  ${C.gray('· /new 新会话')}`, 1, 0),
      basis: 'auto', shrink: 0,
    },
    { component: scroll, basis: 0, grow: 1, minSize: 3 },
    { component: editor, basis: 'auto', shrink: 1, minSize: 3 },
    { component: thinkingPreview, basis: 'auto', shrink: 0 },  // 思考预览（默认隐藏）
    { component: todosView, basis: 'auto', shrink: 0 },
    { component: statusBar, basis: 'auto', shrink: 0 },
    { component: status, basis: 'auto', shrink: 0 },
  ]))
  tui.setFocus(editor)

  // ---- session metrics (mirror the web StatsLine + ContextMeter) ----
  const stats: ReplStats = createStats(PROVIDER, MODEL)
  const statsStyle = { gray: C.gray, cyan: C.cyan, green: C.green, yellow: C.yellow, red: C.red }
  /** Capture the cumulative metrics values used as a turn-delta base. */
  const captureStatsSnapshot = (): TurnDelta => ({
    steps: stats.steps, llmMs: stats.llmMs, toolMs: stats.toolMs, outputTokens: stats.outputTokens,
  })
  // Snapshot of cumulative stats at the last turn end, so finishTurn can compute the
  // per-turn delta that feeds the pet's end-of-turn banter.
  let turnBase = captureStatsSnapshot()
  // Whether the live phase was active at the last renderStats; detects the idle→live
  // transition so a fresh turn restarts the metrics window at the leading fields.
  let liveWasActive = false
  const renderStats = (): void => {
    // Live step-phase (e.g. "思考中 1.2s") is pinned as the status-bar head while
    // the metrics fields scroll horizontally beneath it.
    const live = livePhaseText(stats, Date.now(), statsStyle)
    const header = live !== undefined ? live : ''
    // A turn just went live: the whole status region re-lays out (head appears, usage
    // yields its width), so jump back to the leading fields, a forward auto-slide, and
    // auto back on — a fresh turn starts from a clean, moving metrics view.
    if (live !== undefined && !liveWasActive) {
      statusBar.start = 0
      statusBar.dir = 1
      statusBar.auto = true
    }
    liveWasActive = live !== undefined
    const fields = formatStatsFields(stats, statsStyle)
    const body = fields.length > 0 ? fields : [C.gray('指标将在此显示')]
    // Quota/usage is minor info: show it only while idle, and give the width to the
    // left metrics as soon as a turn runs (thinking / answering / tools).
    const mid = live !== undefined ? '' : usageLine
    const credit = stats.providerName === 'tencent' ? creditsByModel.get(stats.modelName) : undefined
    const right = `${C.gray(`@${hostLabel}`)} ${formatModelTag(C.blue(stats.providerName), C.green(stats.modelName))}${credit !== undefined ? ` ${C.gray(`· ${credit}`)}` : ''}`
    statusBar.setText(body, right, mid, header)
    tui.requestRender()
  }
  // While a turn is running, re-render the stats line each second so the live
  // phase's elapsed clock stays honest without blocking on events.
  let liveTimer: ReturnType<typeof setInterval> | null = null
  let liveTimerActive = false
  const stopLiveTimer = (): void => {
    if (liveTimer !== null) {
      clearInterval(liveTimer)
      liveTimer = null
    }
    liveTimerActive = false
    // A stopped turn should drop the live segment from the status bar.
    if (stats.livePhase === 'idle') renderStats()
  }
  const startLiveTimer = (): void => {
    if (liveTimerActive) return
    stopLiveTimer()
    liveTimerActive = true
    liveTimer = setInterval(() => {
      if (stats.livePhase !== 'idle') renderStats()
    }, 1_000)
  }

  // Multi-line status bar auto-rotation: every few seconds advance the two-row
  // metrics window upward so the user can read the later groups without pressing
  // anything. Manual Alt+↑/↓ pauses it; Alt+0 re-enables following from the top.
  // Single-line status bar auto-slide: every few seconds forward the fixed middle
  // window by one field so later metrics roll into view. Manual Alt+←/→ pauses it;
  // Alt+0 re-enables following from the first field.
  let rotateTimer: ReturnType<typeof setInterval> | null = null
  const stopRotateTimer = (): void => {
    if (rotateTimer !== null) {
      clearInterval(rotateTimer)
      rotateTimer = null
    }
  }
  const startRotateTimer = (): void => {
    stopRotateTimer()
    rotateTimer = setInterval(() => {
      // Slide only while idle: during a turn the live "/作答中" head is the focus,
      // so keep the metrics window still (and auto-off is respected too).
      if (!statusBar.auto || stats.livePhase !== 'idle') return
      statusBar.stepRotate(terminal.columns)
      statusBar.invalidate()
      tui.requestRender()
    }, 3_500)
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

  // Thinking preview: 双通道显示
  // 1. thinkingView: transcript 中的历史思考（灰色斜体，保留）
  // 2. thinkingPreview: 底部浮动区域（最新 3 行，思考结束后 2 秒消失）
  const THINKING_MAX_LINES = 3
  const THINKING_HIDE_DELAY_MS = 2000  // 思考结束后 2 秒自动隐藏
  let thinkingView: Text | null = null
  let thinkingBuf = ''
  let thinkingTimer: ReturnType<typeof setTimeout> | null = null
  let thinkingHideTimer: ReturnType<typeof setTimeout> | null = null
  const THINKING_FLUSH_MS = 60
  const THINKING_FLUSH_CHARS = 400
  /** 获取思考预览的最新 N 行（按换行符分割，取最后 N 行） */
  const getThinkingPreviewLines = (buf: string): string => {
    const lines = buf.split('\n')
    // 过滤空行，取最后 N 行
    const nonEmpty = lines.filter(l => l.trim().length > 0)
    const lastN = nonEmpty.slice(-THINKING_MAX_LINES)
    return lastN.join('\n')
  }

  /** 更新思考预览显示 */
  const updateThinkingPreview = (): void => {
    if (thinkingTimer !== null) {
      clearTimeout(thinkingTimer)
      thinkingTimer = null
    }
    const preview = getThinkingPreviewLines(thinkingBuf)
    if (preview.length > 0) {
      thinkingPreview.setText(C.thinking('💭 ' + preview))
      // Feed the swimming whale the model's real latest thought (WorkBuddy-style).
      whaleSwim = { ...whaleSwim, liveThinking: liveThinkingQuip(thinkingBuf) }
      // 取消隐藏定时器
      if (thinkingHideTimer !== null) {
        clearTimeout(thinkingHideTimer)
        thinkingHideTimer = null
      }
    }
    tui.requestRender()
  }

  /** 延迟隐藏思考预览（思考结束后调用） */
  const scheduleHideThinkingPreview = (): void => {
    if (thinkingHideTimer !== null) clearTimeout(thinkingHideTimer)
    thinkingHideTimer = setTimeout(() => {
      thinkingHideTimer = null
      thinkingPreview.setText('')
      whaleSwim = { ...whaleSwim, liveThinking: null } // thinking over: hand the whale back to its canned quips
      tui.requestRender()
    }, THINKING_HIDE_DELAY_MS)
  }
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
  let cardVisibility: ToolCardVisibility = 'expanded'

  /** User-message bubble: blue background covers only the text (bubble style), not a full-width bar.
   *  Wraps to the rendered width and adapts to terminal resize, leaving a transparent right gap. */
  class UserBubble {
    readonly text: string
    readonly label: string
    readonly padX = 1
    constructor(text: string) {
      this.text = text
      this.label = '🧑💻' // 用户消息前缀：开发者的形象 emoji（代替“你”）
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

  const addUser = (text: string): UserBubble => {
    const bubble = new UserBubble(text)
    transcript.addChild(bubble)
    // 一条可见空行垫在用户消息之后，把这条消息和 agent 回复/下一条视觉上分开。
    // 注意不能用空文本 Text('')——pi-tui 对空文本 render 返回 []（不占行）；给一个空格才会渲染成一行空白。
    transcript.addChild(new Text(' ', 0, 0))
    tui.requestRender()
    return bubble
  }
  const startAssistant = (): void => {
    // 正文开始时：封存思考段落 + 延迟隐藏底部预览
    flushThinking()
    scheduleHideThinkingPreview()
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
  /** The `🐳 ` prefix `startAssistant` / `appendAssistant` writes at the head of a fresh assistant reply. */
  const ASSISTANT_PREFIX = C.gray('🐳 ')
  /** Replace the buffered assistant Markdown with the authoritative full text (replayed/block-end). */
  const replaceAssistant = (text: string): void => {
    if (assistantView === null) {
      startAssistant()
    }
    // A block-end carries the authoritative full text of an already-streamed block;
    // replacing the body must not wipe the `🐳` prefix that startAssistant already
    // wrote, or replies lose their opening whale. Keep the prefix, swap the body.
    assistantBuf = assistantBuf.startsWith(ASSISTANT_PREFIX)
      ? ASSISTANT_PREFIX + text
      : text
  }
  /** Re-render the buffered assistant Markdown now (the reducer gates this to the flush cadence). */
  const flushAssistant = (): void => {
    if (assistantView !== null) {
      assistantView.setText(assistantBuf)
      tui.requestRender()
    }
  }
  /** 把累积的思考缓冲刷进双通道：transcript 历史 + 底部浮动预览。 */
  const flushThinking = (): void => {
    if (thinkingTimer !== null) {
      clearTimeout(thinkingTimer)
      thinkingTimer = null
    }
    // 1. transcript 历史（灰色斜体，保留）
    if (thinkingView !== null) {
      thinkingView.setText(thinkingBuf === '' ? '' : C.thinking(thinkingBuf))
    }
    // 2. 底部浮动预览（最新三行，思考结束后 2 秒消失）
    updateThinkingPreview()
  }
  /** 累积一条 reasoning delta；按"长度阈值 + 短定时器"节流刷新，避免逐 token 刷屏。 */
  const addThinkingLine = (text: string): void => {
    // 首次调用时创建 transcript 视图
    if (thinkingView === null) {
      thinkingView = new Text('', 1, 0)
      transcript.addChild(thinkingView)
    }
    thinkingBuf += text
    if (thinkingBuf.length >= THINKING_FLUSH_CHARS) {
      flushThinking()
      return
    }
    if (thinkingTimer === null) {
      thinkingTimer = setTimeout(() => {
        thinkingTimer = null
        flushThinking()
      }, THINKING_FLUSH_MS)
    }
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
    setStatus(`${C.cyan('工具卡')}：${C.gray(TOOL_CARD_LABEL[cardVisibility])}`)
  }

  /** Apply the effects produced by the reducer to the terminal widgets. */
  const applyEffects = (effects: readonly ReplEffect[]): void => {
    for (const effect of effects) {
      switch (effect.kind) {
        case 'appendAssistant': appendAssistant(effect.text); break
        case 'replaceAssistant': replaceAssistant(effect.text); break
        case 'appendThinking': addThinkingLine(effect.text); break
        case 'flushAssistant': flushAssistant(); break
        case 'newAssistantBlock': newAssistantBlock(); break
        case 'toolCall': addToolCall(effect.name, effect.args); break
        case 'toolResult': addToolResult(effect.summary); break
        case 'abnormalTurnEnd': addToolResult(C.red(`✗ turn 异常: ${JSON.stringify(effect.reason)}`)); break
        case 'renderStats': renderStats(); break
        case 'error': addToolResult(C.red(`✗ ${JSON.stringify(effect.data)}`)); break
        case 'todoWrite': latestTodos = effect.todos; renderTodoBar(); break
        case 'goalChange': latestGoal = effect.goal; latestGoalRounds = effect.roundsStarted; renderTodoBar(); break
        case 'finishTurn': break // handled below (turn bookkeeping)
      }
    }
  }
  /** 上一轮结束后自动发送队首消息；一次只发一条，随各轮结束逐步清空队列。 */
  const flushQueue = (): void => {
    if (shuttingDown || pendingQueue.length === 0) return
    const next = pendingQueue.shift()
    if (next === undefined) return
    // The bubble was echoed at enqueue time; echo: false avoids a duplicate.
    void submitTurn(next.text, false)
  }
  /**
   * Esc while idle: pull the last queued message back into the editor for
   * editing (or discarding). The enqueue-time bubble leaves the transcript and
   * the text lands in the input box; the editor's own draft is overwritten —
   * the queued message is the newest text and the only one recoverable, so it
   * wins. Returns true when a message was unqueued.
   */
  const unqueueLast = (): boolean => {
    const last = pendingQueue.pop()
    if (last === undefined) return false
    transcript.removeChild(last.bubble)
    transcript.removeChild(last.reminder)
    editor.setText(last.text)
    tui.requestRender()
    return true
  }
  /**
   * Esc 的统一入口：队列非空时优先撤回最后一条排队消息。排队只在 busy 时发生，
   * 所以队列非空几乎总意味着 busy——若先判 busy，Esc 就永远轮不到撤回，还会在
   * 中断本轮后经 flushQueue 把队首消息立刻发出去，正是"撤回没生效"的体验。
   * 队列已空才回落到老语义：busy 中断本轮。返回 true 表示按键已消费。
   */
  const handleEscape = (): boolean => {
    if (pendingQueue.length > 0) {
      const wasBusy = busy
      unqueueLast()
      // 撤回反馈只走状态栏一句话：文本回到输入框、气泡与"已排队"提醒消失本身就是
      // 主反馈，不再往转录区加提醒卡。busy 时按 Esc 的常见本意是中断，补一句下一步。
      const tail = wasBusy ? '，本轮仍在进行，再按 Esc 中断本轮' : ''
      setStatus(C.yellow(`↩ 已撤回排队消息（剩 ${pendingQueue.length} 条）${tail}`))
      return true
    }
    if (busy) {
      sendInterrupt()
      return true
    }
    return false
  }
  const finishTurn = (): void => {
    // 收口 thinking：冲刷缓冲 + 清空底部预览 + 重置 transcript 视图给下一轮
    flushThinking()
    thinkingView = null
    thinkingBuf = ''
    thinkingPreview.setText('')
    whaleSwim = { ...whaleSwim, liveThinking: null } // turn over: the whale stops parroting thoughts
    assistantView = null
    assistantBuf = ''
    // Detach the active card so a later command result starts a fresh `→ ...` card,
    // but keep the finished card in `cards` so Ctrl+O still cycles historic cards.
    activeCard = null
    busy = false
    interruptRequested = false // re-arm Esc for the next turn; the reducer's copy is cleared by its own turn/end case
    stopLiveTimer()
    // Per-turn cost line (DeepSeek list price; see DEEPSEEK_CNY_PER_MTOK).
    const costLine = formatTurnCost({
      billedInput: stats.billedInput - turnCostBaseline.billedInput,
      outputTokens: stats.outputTokens - turnCostBaseline.outputTokens,
      cacheRead: stats.cacheRead - turnCostBaseline.cacheRead,
    })
    if (costLine !== undefined) addToolResult(C.gray(costLine))
    // Long-turn completion notification: toasts when the user likely switched
    // away; DSH_REPL_NOTIFY=off kills it, DSH_REPL_NOTIFY_WX=1 also pushes WeChat.
    const decision = shouldNotifyTurnComplete(Date.now() - turnStartedAt)
    if (decision.notify) {
      const label = lastPromptSent === '' ? '任务' : lastPromptSent.slice(0, 60)
      sendSystemNotification('dsh-repl 任务完成', label).then(() => {}, () => {})
      if (process.env.DSH_REPL_NOTIFY_WX === '1') {
        sendToWechat(`✅ dsh-repl 任务完成：${label}`).then(() => {}, () => {})
      }
    }
    tui.requestRender()
    // 上一轮结束：若队列有等待的普通消息，自动发送下一条。
    flushQueue()
  }
  const finishTurnFromEffects = (effects: readonly ReplEffect[]): void => {
    // finishTurn is applied after the visible effects so the reducer stays the single source of turn state.
    if (effects.some(e => e.kind === 'finishTurn')) finishTurn()
  }

  /** Replay a persisted session's event log into the transcript so a resumed session shows its history. */
  const replaySession = (sessionId: string): void => {
    for (const event of readSessionEvents(sessionId)) {
      if (event.type === 'user/message') {
        // User messages are not rendered by the reducer; surface the human's own
        // text directly (and skip system injections like skill catalogs).
        const text = userMessageText(event)
        if (text !== undefined) addUser(text)
        continue
      }
      const effects = reduceSessionEvent(reducerState, event, stats)
      applyEffects(effects)
      finishTurnFromEffects(effects)
    }
  }

  // ---- runtime ----
  let client = new HarnessClient({
    command: LAUNCH.command,
    args: LAUNCH.args,
    cwd,
    env: process.env,
  })
  let runtimeEpoch = 0 // bumped on every runtime restart; the subscription loop rebuilds on a change
  // Open directly on a historical session (resume is the default behavior; the
  // `--resume [id]` flag requests it explicitly) so the user continues the
  // previous conversation instead of starting blank. The runtime resumes the
  // id from disk via server-side `agents.resume`, so its persisted context is
  // loaded. A fresh uuid is the fallback when there is nothing to resume or
  // startup-resume is disabled. An explicit id (from the cross-workspace
  // handoff) may name a session in another workspace; a bare resume picks the
  // most recent session of *this* workspace.
  const initialSessions = options.resume !== false ? await listSessions() : []
  let resumedStartupId: string | undefined
  let sessionId = `repl-${randomUUID()}`
  if (typeof options.resume === 'string') {
    resumedStartupId = options.resume
    sessionId = options.resume
  } else if (initialSessions.length > 0 && initialSessions[0] !== undefined) {
    sessionId = initialSessions[0].sessionId
    resumedStartupId = sessionId
  }
  let busy = false
  let shuttingDown = false
  // ESC interrupted the active turn; cleared in finishTurn when the turn/end lands
  // (avoids a double cancel). The reducer clears its own copy on turn/end, but this
  // closure flag is what sendInterrupt's guard reads — leaving it set silently kills
  // every later Esc interrupt.
  let interruptRequested = false
  /**
   * 忙期排队的用户消息（普通对话）。命令（/…）忙时即时处理、不入队。
   * `bubble` 是入队时回显的用户气泡——Esc 撤回最后一条排队消息时随队列项
   * 一并从转录区移除，撤回的文本回到编辑器可改可弃。
   */
  interface QueuedMessage {
    readonly text: string
    readonly seq: number
    readonly bubble: UserBubble
    /** 入队时回显的"⏳ 已排队"提醒节点；Esc 撤回时随队列项一并移除。 */
    readonly reminder: Text
  }
  const pendingQueue: QueuedMessage[] = []
  /** Usage snapshot at the start of the live turn, for the per-turn cost line. */
  let turnCostBaseline = { billedInput: 0, outputTokens: 0, cacheRead: 0 }
  const reducerState: ReplReducerState = createReducerState()

  const newSession = (): void => {
    sessionId = `repl-${randomUUID()}`
    // Identity first, wake second: the subscription loop's re-check then always
    // sees the new session (see runSubscription).
    notifySessionSwitch()
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
    // 进入重建窗口：sessionId 要到下面 newSession() 才更新，期间订阅循环
    // 不得拿旧身份去订阅已关闭的旧 client（见 runSubscription 的重启守卫）。
    runtimeRestarting = true
    // Release the blocking wait BEFORE closing the old client so the loop's
    // identity re-check classifies the close rejection as a planned rebuild.
    notifySessionSwitch()
    try { await client.close() } catch { /* the old subprocess may already be gone */ }
    client = new HarnessClient({ command: LAUNCH.command, args: LAUNCH.args, cwd, env: process.env })
    client.start()
    try {
      await client.initialize({ cwd, provider: opts.provider, model: opts.model })
    } catch (error) {
      addToolResult(C.red(`✗ 失败: ${error instanceof Error ? error.message : String(error)}`))
      setStatus('失败')
      resumePet()
      // 退出重建窗口并唤醒订阅循环：旧会话在磁盘上，新 runtime 可续流；
      // runtime 若真死了，循环会以「会话事件流已断开」如实上报。
      runtimeRestarting = false
      notifySessionSwitch()
      return
    }
    stats.providerName = opts.provider
    stats.modelName = opts.model
    loadModels((line) => { addToolResult(line) })
    await refreshCredits()
    // 先出重建窗口再换身份：两步之间无 await，循环观察不到中间态；
    // newSession() 改完 sessionId 即唤醒，循环以新身份重建订阅。
    runtimeRestarting = false
    newSession()
    renderStats()
    showIdleStatus()
  }

  // ---- model registry (parsed from the runtime config via core.loadModelsFromConfig) ----
  let modelList: ReturnType<typeof loadModelsFromConfig> = []
  /** Re-parse the model registry; `report` surfaces a failed parse (tests inject a sink). */
  const loadModels = (report: (line: string) => void = console.error): void => {
    modelList = loadModelsFromConfig(readFileSync(CONFIG, 'utf8'))
    if (modelList.length === 0) {
      report(C.red(`读取模型配置失败或未发现模型：${CONFIG}`))
      modelList = [{ id: MODEL, name: MODEL, provider: PROVIDER, contextWindow: undefined, maxTokens: undefined }]
    }
  }
  loadModels()

  // Billing multipliers (picker / /models / status bar) for tencent-route models,
  // keyed by model id. Refreshed with the registry so /reload picks up proxy-side changes.
  let creditsByModel = new Map<string, string>()
  const refreshCredits = async (): Promise<void> => {
    creditsByModel = await fetchModelCredits(CREDITS_URL)
  }
  void refreshCredits()

  /** Switch the active model by its declaring route (responses/completions). */
  const switchModel = (modelId: string, provider?: string): Promise<void> => {
    if (busy) {
      setStatus(C.yellow('对话进行中，等本轮结束再切换模型'))
      return Promise.resolve()
    }
    const route = provider ?? pickRoute(modelId, modelList, PROVIDER)
    if (modelId === stats.modelName && route === stats.providerName) return Promise.resolve()
    return restartRuntime({ provider: route, model: modelId, announce: `(切换模型: ${modelId} · ${route})` })
  }

  /** Model picker (overlay) with a type-to-filter search box. Items carry their
   *  registry index as the value, so model ids containing `:` stay addressable. */
  const showModelPicker = (): void => {
    const items: PickerItem[] = modelList.map((m, index) => {
      const id = `${m.provider}:${m.id}`
      const iface = m.provider.includes('completions') ? 'completions' : 'responses'
      const credits = m.provider === 'tencent' ? creditsByModel.get(m.id) : undefined
      return {
        value: String(index),
        label: m.name,
        description: `${id} · ctx ${m.contextWindow !== undefined ? fmtTokens(m.contextWindow) : '?'} · ${iface}${credits !== undefined ? ` · ${credits}` : ''}`,
      }
    })
    const current = modelList.findIndex(m => m.id === stats.modelName && m.provider === stats.providerName)
    const dialog = new FilterPickerDialog(
      items,
      current >= 0 ? String(current) : '',
      10,
      selectTheme,
      (item) => {
        tui.hideOverlay()
        const model = modelList[Number(item.value)]
        if (model === undefined) return
        void switchModel(model.id, model.provider)
      },
      () => { tui.hideOverlay() },
      '\x1b[90m /model 搜索（输入过滤 · Esc 清空 / 再按退出）\x1b[0m',
    )
    tui.showOverlay(dialog)
  }
  const listModels = (): void => {
    const lines = modelList.map((m) => {
      const iface = m.provider.includes('completions') ? 'completions' : 'responses'
      const active = m.id === stats.modelName && m.provider === stats.providerName
      const credits = m.provider === 'tencent' ? creditsByModel.get(m.id) : undefined
      const creditTag = credits !== undefined ? `  ${credits === '免费' ? C.green(credits) : C.yellow(credits)}` : ''
      return `  ${active ? C.green('● ') : C.gray('  ')}${C.cyan(m.id)}  ${C.gray(m.name)}  ${C.gray(`[${m.provider}]`)}  ctx ${m.contextWindow !== undefined ? fmtTokens(m.contextWindow) : '?'}${creditTag}  ${active ? C.gray('(当前)') : C.gray(`[${iface}]`)}`
    })
    addUser(`${C.bold('可用模型')} (${modelList.length}):\n${lines.join('\n')}\n ${C.gray('输入 /model 打开选择器，或 /model <id> 直接切换')}`)
  }

  // ---- resume (continue a historical session) ----

  /**
   * Hand a session over to a fresh REPL process running in the workspace the
   * session was created in. The REPL is bound to `process.cwd()` — the runtime
   * spawns in it and filesystem/shell tools resolve against it — so resuming a
   * session from another workspace requires re-entering that directory. Instead
   * of forking an in-process agent (the official TUI's `execve` luxury), we
   * spawn the same entrypoint (`bin.js`) with the session id and the target
   * workspace, inherit our stdio so the new TUI owns the terminal, and restart.
   *
   * The spawned process re-binds via `--resume <id> --cwd <dir>`; `runRepl`
   * resolves the id across all workspaces and `process.chdir`'s first.
   */
  const handoffToWorkspace = (id: string, cwd: string): void => {
    if (!existsSync(cwd)) {
      addToolResult(C.red(`✗ 目标工作区不存在: ${cwd}`))
      tui.requestRender()
      return
    }
    const entry = process.argv[1]
    if (entry === undefined || entry === '') {
      addToolResult(C.red('✗ 无法确定本进程入口，跨工作区恢复不可用'))
      tui.requestRender()
      return
    }
    const child = spawn(process.execPath, [entry, '--resume', id, '--cwd', cwd], {
      cwd,
      stdio: 'inherit',
      env: process.env,
      detached: false,
    })
    child.on('error', (error: Error) => {
      addToolResult(C.red(`✗ 跨工作区恢复失败: ${error.message}`))
      tui.requestRender()
    })
    // The current process hands the terminal off by shutting down; the child is
    // our exact replacement, so exit immediately after spawning (never wait).
    shutdown()
  }

  /**
   * Switch the REPL's target session to the given historical id and reset
   * turn-scoped state. The subscription loop notices the id change and rebuilds
   * on the new session; the next `client.prompt` then runs on that session,
   * whose persisted context the runtime loads from disk. Resetting the stats
   * and reducer state so the resumed turn starts from a clean slate.
   *
   * When the target session was created in a *different* workspace (`cwd` from
   * the picker entry), delegate to {@link handoffToWorkspace} instead of
   * switching in place: this process is bound to its own directory and cannot
   * safely reach a session whose workspace it did not launch in.
   * @param id - a session id (from {@link listSessions} or a `/resume <id>` run).
   * @param cwdToResume - the workspace the session was created in (undefined →
   * the current workspace).
   */
  const resumeTo = (id: string, cwdToResume?: string): void => {
    if (busy) {
      setStatus(C.yellow('对话进行中，等本轮结束再恢复会话'))
      return
    }
    if (id === sessionId && (cwdToResume === undefined || cwdToResume === process.cwd())) {
      setStatus(C.yellow(`已在会话 ${id.slice(0, 20)}… 中`))
      return
    }
    const targetCwd = cwdToResume ?? process.cwd()
    if (targetCwd !== process.cwd()) {
      addUser(C.gray(`(跨工作区恢复 ${C.green(id.slice(0, 20))}… → ${targetCwd})`))
      setStatus(`切换到 ${targetCwd} 后继续会话…`)
      tui.requestRender()
      setTimeout(() => { handoffToWorkspace(id, targetCwd) }, 0)
      return
    }
    sessionId = id
    // Identity first, wake second (see runSubscription).
    notifySessionSwitch()
    Object.assign(reducerState, createReducerState())
    Object.assign(stats, createStats(PROVIDER, MODEL))
    addUser(`(恢复会话 ${C.green(id.slice(0, 20))}…)`)
    setStatus(`已恢复会话，继续对话: ${id.slice(0, 20)}…`)
    resumePet()
  }

  /** Monotonic guard for the async resume scan: only the newest /resume press
   *  may open the picker, so a slow disk scan cannot resurrect a stale overlay. */
  let resumeScanSeq = 0
  let searchScanSeq = 0

  /**
   * Cross-session content search (ctrl+r / /search): scan the most recent
   * sessions' logs for user/assistant message lines and offer them through the
   * filter picker; picking one resumes that session. The scan is cancellable —
   * a newer invocation supersedes an in-flight one by sequence.
   */
  const showSearchPicker = async (): Promise<void> => {
    const scan = ++searchScanSeq
    setStatus(C.gray('扫描会话内容…'))
    const sessions = await listAllSessions()
    const items: PickerItem[] = []
    const seen = new Set<string>()
    for (const session of sessions.slice(0, 25)) {
      if (scan !== searchScanSeq) return // superseded
      for (const line of searchableLines(readSessionEvents(session.sessionId))) {
        for (const raw of line.split('\n')) {
          const trimmed = raw.trim()
          if (trimmed.length < 6) continue
          const label = trimmed.length > 70 ? `${trimmed.slice(0, 70)}…` : trimmed
          if (seen.has(label)) continue
          seen.add(label)
          items.push({
            value: session.sessionId,
            label,
            description: describeSession(session, { gray: C.gray, cyan: C.cyan, green: C.green, yellow: C.yellow }),
          })
        }
        if (items.length >= 400) break
      }
      if (items.length >= 400) break
    }
    if (scan !== searchScanSeq) return // superseded
    if (items.length === 0) {
      addUser(C.gray('没有可搜索的会话内容'))
      showIdleStatus()
      return
    }
    const dialog = new FilterPickerDialog(
      items,
      undefined,
      10,
      selectTheme,
      (item) => {
        tui.hideOverlay()
        resumeTo(item.value)
      },
      () => {
        tui.hideOverlay()
        showIdleStatus()
      },
      '\x1b[90m 跨会话搜索（输入关键字过滤消息 · Enter 跳到该会话 · Esc 退出）\x1b[0m',
    )
    tui.showOverlay(dialog)
  }

  /**
   * Upload one image to the runtime's attachment store and hold the ref for
   * the next prompt send; the status line tracks the pending count. Both the
   * ctrl+v clipboard grab and `@file` image mentions land here.
   */
  const attachClipboardImage = async (path: string, mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' = 'image/png', label = '截图'): Promise<void> => {
    setStatus(C.gray('上传图片附件…'))
    try {
      const data = readFileSync(path)
      const r = await client.attachImages({
        images: [{ dataBase64: data.toString('base64'), mediaType, name: path.split('/').pop() ?? 'image' }],
      })
      pendingImages = [...pendingImages, ...r.attachments]
      setStatus(C.green(`📎 已附${label} ×${pendingImages.length}，输入说明后回车发送`))
    } catch (error) {
      setStatus(C.red('图片附件上传失败'))
      addToolResult(C.red(`✗ ${error instanceof Error ? error.message : String(error)}`))
    }
    tui.requestRender()
  }
  /** Historical-session picker (overlay), newest first, across every workspace.
   *  The scan is async (bounded directory walk), so show progress on the status
   *  row and let a newer request supersede an in-flight one. */
  const showResumePicker = async (): Promise<void> => {
    const scan = ++resumeScanSeq
    const currentCwd = process.cwd()
    setStatus(C.gray('扫描历史会话…'))
    const sessions = await listAllSessions()
    if (scan !== resumeScanSeq) return // a newer /resume superseded this scan
    if (sessions.length === 0) {
      addUser(C.gray('没有找到历史会话（.sessions 目录无会话或 DSH_SESSION_ROOT 不可读）'))
      showIdleStatus()
      return
    }
    const items = sessions.map(s => ({
      value: s.sessionId,
      label: s.sessionId.slice(0, 12) + '…',
      description: `${describeSession(s, { gray: C.gray, cyan: C.cyan, green: C.green, yellow: C.yellow })}${s.sessionId === sessionId ? C.green(' (当前)') : ''}${s.cwd !== undefined && s.cwd !== currentCwd ? C.gray(` · ${s.cwd}`) : ''}`,
    }))
    const cwdById = new Map(sessions.map(s => [s.sessionId, s.cwd]))
    /** Open the confirm dialog for deleting one historical session (never the live one). */
    const confirmDelete = (item: PickerItem): void => {
      if (item.value === sessionId) {
        addUser(C.yellow('当前会话不能删除（/new 开新会话后再删旧的）'))
        return
      }
      const confirm = new ConfirmDialog(
        `删除历史会话 ${item.label}？\n${C.gray(item.description.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 60))}\n${C.red('此操作不可恢复（会话记录将从磁盘移除）')}`,
        () => {
          tui.hideOverlay()
          const outcome = deleteSessionDir(item.value)
          addUser(outcome === 'deleted'
            ? C.gray(`🗑 已删除历史会话 ${item.label}`)
            : outcome === 'missing'
              ? C.yellow(`会话已不存在: ${item.label}`)
              : C.red(`删除失败: ${item.label}`))
          showIdleStatus()
        },
        () => { tui.showOverlay(dialog) },
        '\x1b[90m Enter 确认删除 · 任意其他键取消\x1b[0m',
      )
      // Reopening the picker dialog underneath is unnecessary: show confirm on top.
      tui.showOverlay(confirm)
    }
    const dialog = new FilterPickerDialog(
      items,
      sessionId,
      10,
      selectTheme,
      (item) => {
        tui.hideOverlay()
        resumeTo(item.value, cwdById.get(item.value))
      },
      () => {
        tui.hideOverlay()
        showIdleStatus()
      },
      '\x1b[90m /resume 搜索（标题/目录/ID 过滤 · Esc 清空 / 再按退出 · Ctrl+D 删除选中会话）\x1b[0m',
      confirmDelete,
    )
    tui.showOverlay(dialog)
  }

  /** Server-side slash commands (routed through the JSON-RPC session/command method). */
  const serverCommands = new Set(['compact', 'feedback', 'goal', 'rename', 'export', 'web-status', 'web-start', 'web-stop', 'web-restart', 'web-switch', 'tui-status', 'tui-start', 'tui-stop', 'tui-restart', 'tui-switch'])
  /**
   * The command vocabulary is derived from the completion list (the single
   * source of truth it and /help both read) plus server commands and the
   * subcommands the parent completion entry documents (`/pet pat`,
   * `/memory remember|edit|clear`), so a new command cannot drift out of
   * fixCommand's reach. Longest-first for fixCommand's prefix matching.
   */
  const commandSubcommandExtras = ['pet pat', 'memory remember', 'memory edit', 'memory clear']
  const allCommands = [
    ...new Set([
      ...commandCompletions.map(entry => entry.value),
      ...serverCommands,
      ...commandSubcommandExtras,
    ]),
  ].sort((a, b) => b.length - a.length)

  /**
   * Process one submission (a user message or a `/command`). Ordinary messages
   * while a turn runs are queued (echoed immediately, sent when the queue
   * drains with `echo: false` so the bubble renders exactly once).
   */
  const submitTurn = async (text: string, echo = true, skipMacroExpansion = false): Promise<void> => {
    const t = fixCommand(text.trim(), allCommands)
    if (t === '') return    // 忙时：普通对话进队列，等上一轮完成后自动发送；命令（/…）即时处理，不进队列。
    // 宏展开：/名称（未注册命令、命中已存宏）→ 存储文本；只展开一层防自引用循环。
    if (t.startsWith('/') && !t.startsWith('/macro ') && t !== '/macro' && !skipMacroExpansion) {
      const expanded = resolveMacro(loadMacros(macroStorePath), t)
      if (expanded !== undefined && expanded !== t) return submitTurn(expanded, echo, true)
    }
    // `!` bang: local shell run that never reaches the model. Sits before the
    // busy gate on purpose — like `/commands` it must fire mid-turn; the async
    // completion prints into the transcript whenever it lands.
    if (t.startsWith('!')) {
      const parsed = parseBangCommand(t)
      if (parsed === undefined || parsed.kind === 'usage') {
        addUser(formatBangUsage())
        return
      }
      setStatus(C.gray(`$ ${parsed.command}`))
      void runShellCommand(parsed.command).then((result) => {
        addUser(formatBangResult(result))
        if (!busy) showIdleStatus()
      })
      return
    }
    if (busy && !t.startsWith('/')) {
      // Echo the user bubble immediately — the message is visible the moment it
      // is sent, not when the queue drains. flushQueue re-enters submitTurn for
      // the real send with echo: false so the bubble renders exactly once.
      const bubble = addUser(t)
      // 提醒用独立 Text 节点而不用 addToolResult：后者会把提醒追加进当前工具卡的
      // body，Esc 撤回时无法随队列项一起摘除，会留下"已排队"的矛盾残留。
      const reminder = new Text(`  ${C.yellow(`⏳ 已排队（第 ${pendingQueue.length + 1} 条），完成上一轮后按序自动发送（Esc 撤回最后一条）`)}`, 1, 0)
      transcript.addChild(reminder)
      pendingQueue.push({ text: t, seq: pendingQueue.length + 1, bubble, reminder })
      tui.requestRender()
      return
    }
    if (t === '/help') {
      addUser(formatHelp(commandCompletions, serverCommands))
      return
    }
    if (t === '/exit' || t === '/quit') {
      shutdown()
      return
    }
    if (t === '/new') {
      // Switching sessionId mid-turn strands the running turn's events (the
      // subscription loop filters by id), so finishTurn never fires and busy
      // sticks forever — reject while a turn runs, like /resume does.
      if (busy) {
        setStatus(C.yellow('对话进行中，等本轮结束再新建会话'))
        return
      }
      newSession()
      addUser('(新会话)')
      setStatus(`会话: ${sessionId.slice(0, 20)}…`)
      resumePet()
      return
    }
    if (t === '/resume') {
      void showResumePicker()
      return
    }
    if (t.startsWith('/resume ')) {
      const id = t.slice(8).trim()
      if (id === '') {
        void showResumePicker()
      } else {
        resumeTo(id)
      }
      return
    }
    if (t === '/context') {
      addUser(formatContextBreakdown(estimateContextBreakdown(readSessionEvents(sessionId)), stats.contextWindow))
      return
    }
    if (t === '/copy' || t.startsWith('/copy ')) {
      const source = lastAssistantText
      const payload = copyPayload(source)
      if (payload === undefined) {
        addToolResult(C.yellow('没有可复制的内容（先等一轮回答完成）'))
        return
      }
      const result = await copyTextToClipboard(payload)
      if (result.ok) {
        const isCode = payload !== source.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/^🐳\s*/, '').trim()
        addToolResult(C.gray(`📋 已复制到剪贴板${isCode ? '（首个代码块）' : ''}：${payload.slice(0, 60).replace(/\n/g, '⏎')}${payload.length > 60 ? '…' : ''}（${payload.length} 字符）`))
      } else {
        addToolResult(C.red(`✗ 复制失败: ${result.error}`))
      }
      return
    }
    if (t === '/diff') {
      addUser(t)
      setStatus(C.gray('git diff…'))
      const out = await workspaceDiff(cwd)
      showIdleStatus()
      addUser(out)
      return
    }
    if (t === '/revert') {
      addUser(t)
      const confirm = new ConfirmDialog(
        `撤销工作区全部未暂存的改动？\n${C.red('相当于 git checkout -- .：未暂存的修改将永久丢弃（含你自己手动改的内容）')}`,
        () => {
          tui.hideOverlay()
          setStatus(C.gray('git checkout…'))
          void revertUnstaged(cwd).then((out) => {
            showIdleStatus()
            addUser(out)
          })
        },
        () => {
          tui.hideOverlay()
          showIdleStatus()
        },
        '\x1b[90m Enter 确认撤销 · 任意其他键取消\x1b[0m',
      )
      tui.showOverlay(confirm)
      return
    }
    if (t === '/doctor') {
      addUser(formatDoctorReport(runDoctorChecks()))
      return
    }
    if (t === '/cost') {
      addUser(formatSessionCost(stats))
      return
    }
    if (t === '/skills') {
      addUser(formatSkillCatalog(scanSkillCatalog(defaultSkillRoots(cwd))))
      return
    }
    if (t === '/agents') {
      addUser(formatAgentsPanel(subagentRuns, Date.now()))
      return
    }
    if (t === '/search') {
      void showSearchPicker()
      return
    }
    if (t === '/macro' || t.startsWith('/macro ')) {
      const rest = t.slice('/macro'.length).trim()
      const addMatch = /^add\s+([a-zA-Z][a-zA-Z0-9-]{0,31})\s+([\s\S]+)$/.exec(rest)
      const rmMatch = /^rm\s+([a-zA-Z][a-zA-Z0-9-]{0,31})$/.exec(rest)
      if (rest === '' || rest === 'list') {
        addUser(formatMacroList(loadMacros(macroStorePath)))
      } else if (addMatch !== null && addMatch[1] !== undefined && addMatch[2] !== undefined) {
        const outcome = upsertMacro(macroStorePath, addMatch[1], addMatch[2].trim())
        addUser(C.gray(outcome === 'added' ? `已添加宏 /${addMatch[1]}，输入 /${addMatch[1]} 展开` : `已更新宏 /${addMatch[1]}`))
      } else if (rmMatch !== null && rmMatch[1] !== undefined) {
        addUser(removeMacro(macroStorePath, rmMatch[1]) ? C.gray(`已删除宏 /${rmMatch[1]}`) : C.yellow(`没有宏 /${rmMatch[1]}`))
      } else {
        addUser(C.yellow('用法：/macro list · /macro add <名称> <文本> · /macro rm <名称> · /<名称> [附加输入]'))
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
      if (id.includes(':')) {
        // `provider:model` — split on the FIRST colon so model ids may contain colons.
        const sep = id.indexOf(':')
        const provider = id.slice(0, sep)
        const modelId = id.slice(sep + 1)
        if (modelList.some(m => m.id === modelId && m.provider === provider)) {
          void switchModel(modelId, provider)
        } else {
          addUser(C.gray(`未知模型: ${id}（/models 查看可用模型）`))
        }
      } else if (modelList.some(m => m.id === id)) {
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
    if (t === '/get_opencode_models') {
      void (async () => {
        setStatus('拉取 opencode 模型列表…')
        try {
          const models = await fetchGatewayModels({
            apiKey: process.env.OPENCODE_GO_API_KEY,
            declaredIds: new Set(modelList.map(m => m.id)),
          })
          const lines = models.map(m => m.configured
            ? `  ${C.green('●')} ${C.cyan(m.id)}  ${C.gray('已配置')}`
            : `  ${C.yellow('○')} ${m.id}  ${C.gray(m.ownedBy === undefined ? '未配置' : `未配置 · ${m.ownedBy}`)}`)
          const unconfigured = models.filter(m => !m.configured).length
          addUser(
            `${C.bold('🌐 opencode 模型列表')} (${models.length}，${C.yellow(String(unconfigured))} 个未配置):\n`
            + `${lines.join('\n')}\n `
            + C.gray('新模型：加入 interactive.cordis.yml 的 models 清单后 /reload 生效'),
          )
          setStatus('完成')
        } catch (error) {
          addToolResult(C.red(`✗ 拉取失败: ${error instanceof Error ? error.message : String(error)}`))
          setStatus('失败')
        }
      })()
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
    if (t === '/memory' || t.startsWith('/memory ')) {
      memoryCommand(t)
      return
    }
    if (t === '/tts') {
      addToolResult(C.yellow('/tts <文本> 朗读 · /tts on|off 自动朗读 · /tts status 状态'))
      return
    }
    if (t === '/tts on') {
      autoSpeak = true
      addToolResult('✓ 自动朗读已开启（每回合结束后朗读助手回答）')
      return
    }
    if (t === '/tts off') {
      autoSpeak = false
      addToolResult('✓ 自动朗读已关闭')
      return
    }
    if (t === '/tts status') {
      addToolResult(`自动朗读：${autoSpeak ? '开' : '关'}`)
      return
    }
    if (t.startsWith('/tts ')) {
      const text = t.slice(5).trim()
      if (text === '' || text === 'on' || text === 'off' || text === 'status') {
        addToolResult(C.yellow('/tts <文本> 朗读 · /tts on|off 自动朗读 · /tts status 状态'))
      } else if (text === 'default') {
        const say = defaultSpeakText()
        const preview = cleanSpokenText(say)
        speakBuffered(say)
        addToolResult(`🎙️ 朗读最后回答：${preview.slice(0, 40)}${preview.length > 40 ? '…' : ''}`)
      } else {
        speakBuffered(text)
        addToolResult(`🎙️ 朗读：${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`)
      }
      return
    }
    if (t === '/weixin' || t === '/wx' || t.startsWith('/weixin ') || t.startsWith('/wx ')) {
      // `/weixin` / `/wx` → send the last assistant reply; `/weixin <文本>` → send that text.
      const body = t.replace(/^\/(weixin|wx)\s*/i, '').trim()
      const text = body === '' || body === 'default' ? cleanSpokenText(defaultSpeakText()) : body
      if (text === '') {
        addToolResult(C.yellow('/weixin 发送最后回答 · /weixin <文本> 发送指定文本 · /wx 同 /weixin'))
        return
      }
      setStatus('📤 正在发到微信…')
      const result = await sendToWechat(text)
      showIdleStatus()
      addToolResult(result)
      return
    }
    if (t === '/text2card' || t.startsWith('/text2card ')) {
      const desc = t.replace(/^\/text2card\s*/, '').trim()
      if (desc === '') {
        addToolResult(C.yellow('/text2card <一句话> 生成一张手绘图文卡片，输出到 ~/text2card/'))
        return
      }
      addUser(t)
      const result = await runText2Card(desc, (line) => { setStatus(line) })
      showIdleStatus()
      addToolResult(result)
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
      showIdleStatus()
      return
    }
    if (t.startsWith('/')) {
      addUser(`未知命令: ${t}`)
      resumePet()
      return
    }
    if (echo) addUser(text)
    lastPromptSent = t
    busy = true
    turnStartedAt = Date.now()
    // Per-turn cost baseline: the finishTurn line reports this turn's usage delta.
    turnCostBaseline = { billedInput: stats.billedInput, outputTokens: stats.outputTokens, cacheRead: stats.cacheRead }
    setPetMood('working')
    startWhale()
    startLiveTimer()
    // `@image` mentions: disk images named in the prompt upload right here and
    // join the pending clipboard refs; the mention text is stripped from the
    // prompt so the model never sees a path it cannot open.
    const { text: textWithoutImages, mentions } = extractImageMentions(t, p => (p.startsWith('/') ? p : join(cwd, p)))
    for (const mention of mentions) {
      try {
        if (!existsSync(mention.path)) {
          addToolResult(C.yellow(`⚠️ 图片不存在，已按普通文本发送: ${mention.path}`))
          continue
        }
        const data = readFileSync(mention.path)
        const imageName = mention.path.split('/').pop()
        const r = await client.attachImages({
          images: [{ dataBase64: data.toString('base64'), mediaType: mention.mediaType, ...(imageName === undefined ? {} : { name: imageName }) }],
        })
        pendingImages = [...pendingImages, ...r.attachments]
      } catch (error) {
        addToolResult(C.red(`✗ 图片附件上传失败 (${mention.path}): ${error instanceof Error ? error.message : String(error)}`))
      }
    }
    const promptBase = mentions.length > 0 ? textWithoutImages : t
    try {
      const injection = memorySnapshot()
      const promptText = injection !== '' ? `[长期记忆上下文]\n${injection}\n\n请在此基础上作答。用户输入：${promptBase}` : promptBase
      // Pending clipboard images ride ahead of the text as image blocks; the
      // refs were uploaded by ctrl+v's session/attach call and are cleared here.
      const imageBlocks = pendingImages.map(ref => ({ type: 'image' as const, attachment: ref }))
      const textBlock = { type: 'text' as const, text: promptText }
      pendingImages = []
      await client.prompt(sessionId, [...imageBlocks, textBlock])
    } catch (error) {
      addToolResult(`请求失败: ${error instanceof Error ? error.message : String(error)}`)
      setPetMood('sad')
      finishTurn()
    }
  }
  // Record every non-empty submission into the editor's prompt history so
  // up/down arrows can recall and re-run recent inputs (commands included).
  //
  // 优化：处理手机粘贴大段文字的情况
  // 不发 bracketed paste 的终端/SSH 客户端会把多行文本按“逐行 + 回车(\r)”发送，
  // 而 pi-tui 的 StdinBuffer 把原始字节拆成单字符事件——监听层永远看不到整段批次，
  // 每个 \r 都直达 Editor 触发一次 onSubmit，逐行各排一条待执行队列。
  // 因此合并只能做在 onSubmit 边界上：150ms 内的连续单行提交视为同一次粘贴，
  // 静默 150ms 后合并成一条消息发送（/ 命令除外，保持逐条即时执行）。
  let lastSubmitAt: number | null = null
  const coalescedLines: string[] = []
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null

  /** Flush the in-flight pasted block as one message; keeps ordering before commands. */
  const flushCoalesced = (): void => {
    if (coalesceTimer !== null) { clearTimeout(coalesceTimer); coalesceTimer = null }
    if (coalescedLines.length === 0 || shuttingDown) { coalescedLines.length = 0; return }
    const merged = coalescedLines.join('\n')
    coalescedLines.length = 0
    void submitTurn(merged)
  }

  editor.onSubmit = (text) => {
    // 统一换行符：\r\n → \n，孤立 \r → \n，防止残留回车导致下游按行拆分。
    const cleanText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (cleanText.trim() === '') return
    editor.addToHistory(cleanText)
    rememberPromptHistory(cleanText)
    const now = Date.now()

    // 单个事件自带多行（bracketed paste 落进草稿后一次回车）：纯文本整体提交；
    // 含 / 命令行则逐行拆开提交（批量命令仍逐条）。
    if (cleanText.includes('\n')) {
      flushCoalesced()
      lastSubmitAt = now
      const lines = cleanText.split('\n')
      const nonEmptyLines = lines.filter(line => line.trim() !== '')
      if (nonEmptyLines.length > 1 && !nonEmptyLines.some(line => line.trim().startsWith('/'))) {
        void submitTurn(cleanText)
      } else {
        for (const line of lines) {
          if (line.trim() !== '') void submitTurn(line)
        }
      }
      return
    }

    // 单行事件：落在合并窗口内的连续提交 = 同一次无 bracketed 粘贴的逐行流，
    // 攒起来等静默窗口到期后一次性发出，避免“一条条的待执行条目”。
    if (shouldCoalesceSubmit(lastSubmitAt, now, cleanText)) {
      coalescedLines.push(cleanText)
      lastSubmitAt = now
      if (coalesceTimer !== null) clearTimeout(coalesceTimer)
      coalesceTimer = setTimeout(flushCoalesced, PASTE_COALESCE_MS)
      return
    }

    flushCoalesced() // 命令或普通单行：先冲掉在途合并块，保证提交顺序
    lastSubmitAt = now
    void submitTurn(cleanText)
  }

  // ---- subscription loop (started after client.start() by the startup block below) ----
  /**
   * Resolve handle for the blocking subscription wait. Switch sites mutate
   * `sessionId`/`runtimeEpoch` first and only then call {@link notifySessionSwitch},
   * so the loop's identity re-check always sees the new session and a switch can
   * never fall into the gap between the check and the blocking `next()`.
   */
  let wakeSubscription: (() => void) | null = null
  /** Wake the blocking subscription wait after a session switch or runtime restart. */
  const notifySessionSwitch = (): void => {
    contextWarned = false
    wakeSubscription?.()
  }
  /**
   * restartRuntime 置位：runtime 正在销毁重建，sessionId 要到新 runtime 起来后
   * 的 newSession() 才更新。置位期间订阅循环不拿旧身份去订阅（旧 client 已
   * 关闭、新 runtime 还没会话），旧流的拒绝一律按计划内重建处理——否则
   * close 的拒绝会被误判成计划外断流，把整个 REPL 带崩（/model 与 /reload
   * 都走 restartRuntime 这条路）。
   */
  let runtimeRestarting = false
  // restartRuntime flips the flag from another closure while this loop awaits;
  // reading it through a function keeps whole-flow analysis from narrowing it.
  const isRuntimeRestarting = (): boolean => runtimeRestarting
  const runSubscription = async (): Promise<void> => {
    for (;;) {
      // 重建窗口：等 restartRuntime 完成身份切换再订阅。不轮询——挂在
      // wake 上，由 newSession() / 失败恢复路径的 notifySessionSwitch 唤醒。
      while (runtimeRestarting) {
        await new Promise<void>((resolve) => { wakeSubscription = resolve })
      }
      const sid = sessionId
      const epoch = runtimeEpoch
      const sub = client.subscribeSessionTree(sid)
      try {
        for (;;) {
          if (sid !== sessionId || epoch !== runtimeEpoch) break
          // Block until the next notification or a switch wake — no polling.
          // The race keeps handlers on both promises, so the losing `next()`'s
          // later rejection (close / runtime death) stays handled.
          const wake = new Promise<void>((resolve) => { wakeSubscription = resolve })
          let notification: Awaited<ReturnType<typeof sub.next>> | undefined
          let streamDead = false
          try {
            notification = await Promise.race([sub.next(), wake.then(() => undefined)])
          } catch {
            streamDead = true // close() or runtime death rejected the wait
          }
          if (sid !== sessionId || epoch !== runtimeEpoch) break // planned switch: rebuild on the new identity
          if (streamDead) {
            if (isRuntimeRestarting()) break // 阻塞期间开始了 runtime 重建：计划内关闭，转换由 restartRuntime 负责
            // Unplanned: the event stream is gone and nothing will revive it.
            throw new Error('会话事件流已断开（运行时可能已退出）')
          }
          if (notification === undefined) continue // spurious wake: re-arm and re-check
          if (notification.method === 'subagent.started' || notification.method === 'subagent.finished') {
            subagentRuns = recordSubagentNotification(subagentRuns, notification.method, notification.params, Date.now())
            continue
          }
          if (notification.method !== 'session.event') continue
          const params = notification.params as { sessionId?: unknown; event?: unknown }
          if (typeof params.sessionId !== 'string' || params.sessionId !== sid) continue
          if (params.event === null || typeof params.event !== 'object') continue
          const event = params.event as { type: string; time: number; data?: unknown }
          const effects = reduceSessionEvent(reducerState, event, stats)
          applyEffects(effects)
          // Capture the final assistant text BEFORE finishTurnFromEffects clears the buffer, so
          // auto read-aloud below reads the completed reply instead of an emptied string.
          const spokenAtTurnEnd = assistantBuf
          finishTurnFromEffects(effects)
          if (effects.some(e => e.kind === 'finishTurn')) {
            renderStats()
            if (spokenAtTurnEnd !== '') lastAssistantText = spokenAtTurnEnd
            // Per-turn delta → pet end-of-turn banter (only when it actually did something).
            const now = captureStatsSnapshot()
            const delta: TurnDelta = {
              steps: now.steps - turnBase.steps,
              llmMs: now.llmMs - turnBase.llmMs,
              toolMs: now.toolMs - turnBase.toolMs,
              outputTokens: now.outputTokens - turnBase.outputTokens,
            }
            turnBase = now
            if (delta.steps > 0 || delta.outputTokens > 0) petCelebrate(formatTurnBanter(delta))
            petTurnDone()
            // Auto-log the turn into the project log and today's daily log (short line).
            const logLine = lastPromptSent !== '' ? `${lastPromptSent.slice(0, 60)}${lastPromptSent.length > 60 ? '…' : ''}` : ''
            if (logLine !== '') {
              memory.add('project', `完成：${logLine}`, cwd)
              memory.add('daily', `完成：${logLine}`, cwd)
            }
            // One-shot context-pressure warning: past the critical threshold the
            // first finished turn of a window suggests /compact (red status bar
            // already shows the ratio; this transcript line reaches the user
            // even when they are not staring at the status bar).
            if (contextPressure(stats) === 'critical' && !contextWarned) {
              contextWarned = true
              addToolResult(C.yellow('⚠️ 上下文已用约 85%，建议 /compact 压缩会话，或 /new 开新会话'))
            }
            if (autoSpeak) speakBuffered(spokenAtTurnEnd)
            showIdleStatus()
            refreshUsage() // 每轮结束后(受 60s 防抖)刷新配额显示
          }
          if (effects.some(e => e.kind === 'abnormalTurnEnd' || e.kind === 'error')) {
            setPetMood('sad')
          }
        }
      } finally {
        wakeSubscription = null
        sub.close()
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
    stopLiveTimer()
    stopRotateTimer()
    stopUsageRefresh()
    flushCoalesced() // 退出前丢弃在途合并块（shuttingDown 已置位，flush 只做清场）
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

  // Ctrl+C is three-stage: running → interrupt; idle with a draft → clear input; idle & empty → exit.
  // Shared by the kitty-protocol branch and the standard ctrl+c branch below.
  const handleCtrlC = (): { consume: true } => {
    if (busy) {
      sendInterrupt()
      return { consume: true }
    }
    if (editor.getText() !== '') {
      editor.setText('')
      tui.requestRender()
      setStatus(C.gray('已清空输入框（再按 Ctrl+C 退出）'))
      return { consume: true }
    }
    shutdown()
    return { consume: true }
  }
  // ESC interrupts streaming output during a turn; when idle it falls through to the editor (e.g. cancel autocomplete).
  const sendInterrupt = (): void => {
    if (!busy || interruptRequested) return
    interruptRequested = true
    reducerState.interruptRequested = true
    setPetMood('sad')
    setStatus(C.yellow('中断中…'))
    void client.cancel(sessionId).catch(() => {
      interruptRequested = false
      showIdleStatus()
    })
  }
  /**
   * Ctrl+G — hand the current draft to $EDITOR (git commit-message mode).
   * Suspends the TUI (raw mode off, alt screen exited), runs the editor over a
   * temp file with inherited stdio, then re-enters the alt screen and forces a
   * full redraw. The draft is only replaced when the edited file is non-empty;
   * an empty save keeps the old draft (same semantics as git).
   */
  const openEditorDraft = async (): Promise<void> => {
    const draftFile = join(tmpdir(), `dsh-repl-draft-${Date.now()}.md`)
    try {
      writeFileSync(draftFile, editor.getText())
    } catch {
      addToolResult(C.red('✗ 无法写入草稿临时文件，$EDITOR 未启动'))
      return
    }
    // GUI editors need flags ("subl -w", "code -w"), so split the spec into argv.
    const editorArgv = editorCommandArgv(process.env.VISUAL ?? process.env.EDITOR)
    const editorLabel = editorArgv.join(' ')
    process.stdin.pause()
    process.stdin.setRawMode(false)
    // Leave the alt screen and clear the main screen so $EDITOR starts from a clean slate.
    terminal.write('\x1b[?1049l\x1b[H\x1b[2J')
    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(editorArgv[0], [...editorArgv.slice(1), draftFile], { stdio: 'inherit' })
      child.on('exit', (code) => { resolve(code ?? 1) })
      child.on('error', () => { resolve(1) })
    })
    let edited = ''
    try {
      edited = readFileSync(draftFile, 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '')
    } catch { /* unreadable/unremoved temp file: keep the old draft */ }
    try { rmSync(draftFile, { force: true }) } catch { /* best-effort cleanup */ }
    process.stdin.setRawMode(true)
    process.stdin.resume()
    // Re-enter the alt screen; the forced redraw repaints everything we left behind.
    terminal.write('\x1b[?1049h')
    if (exitCode === 0 && edited !== '') {
      editor.setText(edited)
      addToolResult(C.gray(`✓ 已从 ${editorLabel} 读回草稿（${edited.length} 字符）`))
    } else if (exitCode !== 0) {
      addToolResult(C.yellow(`${editorLabel} 异常退出 (code=${exitCode})，草稿未变`))
    } else {
      addToolResult(C.gray('编辑结果为空，草稿保持不变'))
    }
    tui.requestRender(true)
  }

  tui.addInputListener((data) => {
    // Any real keypress wakes the dozing pet, matching the bubble's "输入任意键唤醒".
    if (data !== '' && petMood === 'sleeping') setPetMood('idle')
    // DSH_REPL_KEYDEBUG=1 时记录每个按键的原始序列与 busy/focused 状态，用于诊断
    // "快捷键不生效"：有本行日志且状态正常 ⇒ 键已到达并交给编辑器；无日志 ⇒ 终端层截获。
    if (process.env.DSH_REPL_KEYDEBUG === '1') {
      appendFileSync('/tmp/dsh-repl-keys.log',
        `${new Date().toISOString()} data=${JSON.stringify(data)} busy=${busy} focused=${editor.focused}\n`)
    }
    // Ctrl+G：把草稿交给 $EDITOR 编辑（git commit message 模式）。busy 时禁用——编辑器
    // 接管屏幕期间会与本轮流式输出搅在一起——但要说明原因并回显，静默吞键看起来像失灵。
    if (isCtrlG(data)) {
      if (busy) addToolResult(C.yellow('生成中暂不能打开外部编辑器，等本轮结束再按 Ctrl+G'))
      else void openEditorDraft()
      return { consume: true }
    }
    // [ / ]：输入框为空时直接翻页看历史（上一页/下一页）。草稿一旦有内容，两键
    // 恢复普通打字——空输入框即“阅读意图”，这就是打字冲突的内建回退。单字符判断
    // 天然排除括号粘贴（bracketed paste 是一整段长文本）。
    const bracket = bracketScrollAction(data, editor.getText() === '')
    if (bracket !== undefined) {
      tui.scrollBy((bracket === 'up' ? -1 : 1) * Math.max(1, terminal.rows - PAGE_SCROLL_OVERLAP_LINES))
      return { consume: true }
    }
    // iTerm2 用 kitty 协议发送“带 Ctrl 的字母”，形如 ESC[97;9u（Ctrl+A）、ESC[99;9u（Ctrl+C），
    // modifier=9。普通字母/中文仍以标准字符到达（采样实测：我=\u6211、a=0x61、c=0x63），
    // 不会走到这里。但输入法(IME)也会夹杂发出 modifier=1 的 kitty 序列（ESC[NN;1:3u），
    // 那不是真实 Ctrl，若误判会打乱中文输入——因此仅接受 modifier 以 9 开头（Ctrl）的序列。
    const kitty = typeof data === 'string' ? KITTY_CSI_U.exec(data) : null
    if (kitty !== null) {
      const code = Number(kitty[1])
      const mods = kitty[2] ?? ''
      const isCtrl = mods.startsWith('9')
      if (!isCtrl) {
        // 吞掉两类会干扰中文输入的序列：释放事件（IME 伴随的 ;1:3u 属于此类）和无修饰的
        // 码点按键（CSI NN u / CSI NN;1u）。带真实修饰键的 CSI-u 序列（如 shift+pageUp 的
        // CSI NN;2u）放行——吞掉会让上层翻页/导航绑定永远收不到这些键。
        if (isKeyRelease(data)) return { consume: true }
        if (mods === '' || mods === '1' || mods.startsWith('1:')) {
          // Esc 的 kitty 形态（CSI 27u / CSI 27;1u）不能吞：busy 时它是中断本轮的主键、
          // 队列非空时是撤回排队消息的键，与裸 ESC 同义（下方 matchesKey('escape') 只认
          // 裸 ESC 和 modifier=0 的 kitty 形态，;1 变体两边都够不着）。
          // 未消费（idle 且队列空）维持原吞除行为，避免影响编辑器的 autocomplete。
          if (code === 27 && handleEscape()) return { consume: true }
          return { consume: true }
        }
        return undefined
      }
      if (code === 99) { // Ctrl+C：中断 / 清空 / 退出 三级
        // iTerm 会分别投递“按下”和“释放”两个 kitty 事件（ESC[99;9u = press、
        // ESC[99;9:3u = release，:3 是 kitty 的 Release 标志）。释放事件不应触发
        // 三级逻辑，否则第一条清了输入后第二条会误判为“空输入退出”。
        if (isKeyRelease(data)) return { consume: true }
        return handleCtrlC()
      }
      // 其余 Ctrl+字母：映射回单字节控制符喂给编辑器，执行行编辑（Ctrl+A=0x01 … Ctrl+Z=0x1a）。
      if (code >= 97 && code <= 122 && !busy && editor.focused) {
        editor.handleInput(String.fromCharCode(code - 96))
        tui.requestRender()
        return { consume: true }
      }
    }
    if (matchesKey(data, 'escape')) {
      // 撤回排队消息优先于中断本轮（排队只在 busy 时存在，见 handleEscape）；
      // 队列空且 idle 时交给编辑器自己处理 escape（如取消 autocomplete）。
      if (handleEscape()) return { consume: true }
      return undefined
    }
    if (matchesKey(data, 'ctrl+r')) {
      void showSearchPicker()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+v')) {
      if (busy) {
        setStatus(C.yellow('本轮进行中，结束后再贴图'))
        return { consume: true }
      }
      const clipPath = join(tmpdir(), `dsh-clip-${Date.now()}.png`)
      setStatus(C.gray('读取剪贴板图片…'))
      void clipboardImageTo(clipPath).then((result) => {
        if (!result.ok || result.path === undefined) {
          setStatus(C.yellow(`✗ ${result.error ?? '剪贴板读取失败'}`))
          tui.requestRender()
          return
        }
        void attachClipboardImage(result.path)
      })
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+c')) {
      return handleCtrlC()
    }
    if (matchesKey(data, 'ctrl+o')) {
      cycleToolCardVisibility()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+y')) {
      // Same path as /copy: last reply, code block preferred.
      void submitTurn('/copy')
      return { consume: true }
    }
    // 其它终端若直接发单字节控制符（0x01–0x1f），也兜底喂回编辑器。
    if (matchesKey(data, 'ctrl+a') || matchesKey(data, 'ctrl+e') || matchesKey(data, 'ctrl+u')
      || matchesKey(data, 'ctrl+k') || matchesKey(data, 'ctrl+w') || matchesKey(data, 'ctrl+b')
      || matchesKey(data, 'ctrl+f') || matchesKey(data, 'ctrl+d')) {
      if (!busy && editor.focused) {
        editor.handleInput(data)
        tui.requestRender()
        return { consume: true }
      }
    }
    if (matchesKey(data, 'alt+left')) {
      // Slide the metrics window left (earlier fields); manual sliding pauses auto.
      statusBar.auto = false
      statusBar.start = Math.max(0, statusBar.start - 1)
      statusBar.invalidate()
      tui.requestRender()
      return { consume: true }
    }
    if (matchesKey(data, 'alt+right')) {
      statusBar.auto = false
      statusBar.start = Math.min(Math.max(0, statusBar.fields.length - 1), statusBar.start + 1)
      statusBar.invalidate()
      tui.requestRender()
      return { consume: true }
    }
    if (matchesKey(data, 'alt+0')) {
      // Back to the leading fields, forward auto-rotation on, and re-enable.
      statusBar.start = 0
      statusBar.dir = 1
      statusBar.auto = true
      statusBar.invalidate()
      tui.requestRender()
      return { consume: true }
    }
    // 非 bracketed paste 的逐行粘贴不在这里处理：StdinBuffer 已把原始字节拆成
    // 单字符事件，监听层看不到“含 \r 的整段批次”，任何批次级启发式在这里都是死代码。
    // 合并在 editor.onSubmit 的时序去抖（shouldCoalesceSubmit + PASTE_COALESCE_MS）里完成。
    return undefined
  })

  const addWelcome = (): void => {
    const tag = C.green('yuanguangshan定制版')
    const tagCol = 34
    const padTo = (s: string, col: number): string => s + ' '.repeat(Math.max(0, col - visibleWidth(s)))
    // Startup banner: the DeepSeek pixel whale rendered with half-block
    // `▀`/`▄` (2 pixels per terminal cell → 40 cols × 13 rows, smooth pixels),
    // then the title line. True-color codes come from whale-banner.ts.
    const art = [
      ...renderWhaleHalfBlock(),
      '',
      padTo('', tagCol) + tag,
      `  ${C.bold('欢迎使用 DeepSeek Harness')}`,
      `  ${C.gray('────────────────────────────')}`,
      `  ${C.cyan(PROVIDER)} · ${C.green(MODEL)}`,
      `  输入问题开始对话 · ${C.gray('/new')} 新会话 · ${C.gray('/pet')} 宠物 · ${C.gray('/exit')} 退出`,
      `  翻页看历史：${C.bold('[ / ]')} 上一页/下一页（输入后恢复打字）· PgUp/PgDn · Home/End 到顶/底`,
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
    // Replay the restored session's transcript so the historical conversation is
    // visible before the user continues it, then flag the hand-rolled resume.
    replaySession(resumedStartupId)
    addUser(`(已恢复最近会话 ${C.green(resumedStartupId.slice(0, 20))}…)`)
    setStatus(`已恢复会话，继续对话: ${resumedStartupId.slice(0, 20)}…`)
  } else {
    showIdleStatus()
  }
  tui.start()
  startUsageRefresh()
  startRotateTimer()
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
  // 思考预览样式：灰色 + 斜体（组合进一条 ANSI 序列，避免嵌套 reset 截断样式）。
  thinking: (s: string): string => `\x1b[90;3m${s}\x1b[0m`,
  // user-bubble background: color only the text content (see UserBubble), not a full-width dark-blue bar.
  // 44 = blue background, 37 = white foreground — keep the dark blue bubble but use white text for contrast.
  bubbleBg: (s: string): string => `\x1b[44;37m${s}\x1b[0m`,
}
