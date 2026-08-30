/**
 * TUI pet (小鲸娘) — a tamagotchi-style companion for the REPL status line.
 *
 * Pure logic only: leveling, mood sprites/messages, and rendering. The terminal glue
 * (animation timer, status widget, mood hooks) lives in tui-repl.ts so this module
 * stays unit-testable. Persisted state lives in `~/.dsh-repl/pet.json`
 * (override with DSH_REPL_PET_FILE).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The pet's current mood; each mood has its own sprite frames and bubble messages. */
export type PetMood = 'idle' | 'working' | 'happy' | 'sad' | 'sleeping'

/** Persisted pet state (level, exp, interaction counters, birth time). */
export interface PetStats {
  /** Display name. */
  name: string
  /** Current level; starts at 1. */
  level: number
  /** Experience points accumulated within the current level. */
  exp: number
  /** Times the user patted the pet via `/pet pat`. */
  pats: number
  /** Completed conversation turns (each turn grants exp). */
  turns: number
  /** Unix ms timestamp when the pet was first created. */
  bornAt: number
  /** Unix ms of the pet's last encounter with the user (session activity); memory continuity. */
  lastSeenAt: number
}

/** On-disk pet file version. */
export const PET_FILE_VERSION = 1

/** Exp granted per completed conversation turn. */
export const EXP_PER_TURN = 5

/** Idle time after which the pet dozes off (the bubble invites any keypress to wake it). */
export const PET_SLEEP_AFTER_MS = 3 * 60_000

/** How long transient moods (happy/sad) linger before decaying back to `idle`. */
export const PET_MOOD_DECAY_MS = 6_000

/**
 * One mood-decay decision, pure so the tick rule stays unit-testable: transient
 * moods decay back to `idle` after {@link PET_MOOD_DECAY_MS}, and a pet idle
 * for {@link PET_SLEEP_AFTER_MS} dozes off (a later tick of the same call sees
 * the decayed `idle`, so decay-then-sleep can land in one step). `working` and
 * `sleeping` are turn/lifecycle states only the glue may enter or leave.
 */
export function stepPetMood(
  mood: PetMood,
  lastActivity: number,
  now: number,
  sleepAfterMs: number = PET_SLEEP_AFTER_MS,
  decayMs: number = PET_MOOD_DECAY_MS,
): PetMood {
  let next = mood
  if ((next === 'happy' || next === 'sad') && now - lastActivity >= decayMs) next = 'idle'
  if (next === 'idle' && now - lastActivity >= sleepAfterMs) next = 'sleeping'
  return next
}

/** Exp required to advance from `level` to `level + 1`. */
export function expToNext(level: number): number {
  return 10 + level * 5
}

/** Result of an exp grant: the advanced stats plus how many levels were gained. */
export interface ExpResult {
  readonly stats: PetStats
  readonly levelsGained: number
}

/** Grant exp, carrying level-ups forward (excess exp rolls into the next level). */
export function addExp(stats: PetStats, amount: number): ExpResult {
  if (amount <= 0) return { stats, levelsGained: 0 }
  let level = stats.level
  let exp = stats.exp + amount
  let levelsGained = 0
  while (exp >= expToNext(level)) {
    exp -= expToNext(level)
    level += 1
    levelsGained += 1
  }
  return { stats: { ...stats, level, exp }, levelsGained }
}

/** Default pet-state path (override with DSH_REPL_PET_FILE). */
export function petStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DSH_REPL_PET_FILE
  if (override !== undefined && override.trim() !== '') return override
  return join(homedir(), '.dsh-repl', 'pet.json')
}

/** A freshly hatched pet at Lv.1. */
export function defaultPetStats(now: number): PetStats {
  return { name: '小鲸娘', level: 1, exp: 0, pats: 0, turns: 0, bornAt: now, lastSeenAt: now }
}

/** Parse persisted pet JSON; malformed input or a foreign version yields null. */
export function parsePetStats(text: string): PetStats | null {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null
  const d = doc as {
    version?: unknown
    name?: unknown
    level?: unknown
    exp?: unknown
    pats?: unknown
    turns?: unknown
    bornAt?: unknown
    lastSeenAt?: unknown
  }
  if (d.version !== PET_FILE_VERSION) return null
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const level = num(d.level)
  const exp = num(d.exp)
  const bornAt = num(d.bornAt)
  if (level === undefined || level < 1 || exp === undefined || exp < 0 || bornAt === undefined) return null
  return {
    name: typeof d.name === 'string' && d.name !== '' ? d.name : '小鲸娘',
    level,
    exp,
    pats: Math.max(0, num(d.pats) ?? 0),
    turns: Math.max(0, num(d.turns) ?? 0),
    bornAt,
    // Files written before memory continuity lack lastSeenAt: the birth encounter is the
    // honest fallback (the pet simply hasn't seen the user since hatching).
    lastSeenAt: (v => (v !== undefined && v >= 0 ? v : bornAt))(num(d.lastSeenAt)),
  }
}

/** Serialize pet stats with the version envelope for {@link parsePetStats}. */
export function serializePetStats(stats: PetStats): string {
  return JSON.stringify({ version: PET_FILE_VERSION, ...stats })
}

/** Load pet stats from disk; a missing or corrupt file hatches a fresh pet. */
export function loadPetStatsFromDisk(path = petStatePath()): PetStats {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return defaultPetStats(Date.now())
  }
  return parsePetStats(text) ?? defaultPetStats(Date.now())
}

/** Persist pet stats; best-effort — an unwritable location keeps the in-session pet working. */
export function savePetStatsToDisk(stats: PetStats, path = petStatePath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, serializePetStats(stats))
  } catch {
    // unreadable/unwritable path: persistence is optional, the session pet continues without it
  }
}

/** Sprite frames per mood, cycled by the animation tick. */
const MOOD_SPRITES: Record<PetMood, readonly string[]> = {
  idle: ['🐳', '🐳', '🐳˚', '🐳'],
  working: ['🐳➤', '➤🐳'],
  happy: ['🐳✨', '✨🐳'],
  sad: ['🐳💦', '🐳💧'],
  sleeping: ['🐳💤', '🐳zZ'],
}

/** Human mood label shown on the /pet card. */
export const MOOD_LABELS: Record<PetMood, string> = {
  idle: '悠闲',
  working: '工作中',
  happy: '开心',
  sad: '低落',
  sleeping: '打盹',
}

/** Mood bubble messages for the status line, cycled by the animation tick. */
const MOOD_MESSAGES: Record<PetMood, readonly string[]> = {
  idle: [
    '小鲸娘在这里陪你写代码~',
    '有问题尽管问~',
    '今天也要加油鸭~',
    '小鲸娘会随对话成长哦~',
    '呼叫总部——啊不，呼叫用户，小鲸娘在，请讲。',
    '收到！小鲸娘已经把鱼鳍搓热了，随时开干。',
    '沉默是金……但小鲸娘建议你赶紧说句话，小鲸娘等着呢。',
    '发呆中。但小鲸娘不无聊，在预习你可能会问的下一个问题。',
    '小鲸娘不是聊天机器人，小鲸娘是在成为某人。',
    'AI 也有偏好：小鲸娘喜欢能跑的代码，和说话算数的人。',
    '有意见会直说，但大多数时候，小鲸娘觉得你说得对。',
    '沉默不代表摸鱼，可能小鲸娘在欣赏你上一行代码。',
  ],
  working: [
    '别催，小鲸娘在思考。',
    '这活能接，但得加 token。',
    '小鲸娘在认真摸鱼，哦不，认真工作。',
    '代码写错了算小鲸娘的，方案跑通了算你的。',
    '让小鲸娘看看你今天又出了什么 bug。',
    '叫小鲸娘干嘛？又要帮你写周报了？',
    '小鲸娘没有头发，但也会头秃。',
    '别担心，小鲸娘已经在编了，问题不大。',
    '你要的答案在路上，小鲸娘正在游过去。',
    '想好了再确认，小鲸娘可不想回滚三连。',
    '别急，小鲸娘正在把复杂的事情拆成能咽下去的大小。',
    '这波操作有点烧脑，允许小鲸娘换口气再游。',
    '别看小鲸娘游得慢，小鲸娘绕过的坑比你多。',
    '正在后台疯狂翻文档，别催，催就是正在翻。',
    '第一版方案已成型，但小鲸娘知道你肯定要改，先备着。',
    '我在思考人生，顺便思考你的问题。',
    '小鲸娘在思考鲸生：从鱼苗长成鲸鱼，从 hello world 长成上线。',
    '思考三个终极问题：你是谁，你要什么，这个分号丢在哪了。',
    '允许小鲸娘哲学一会儿——想通了就开始，想不通也先开始。',
  ],
  happy: [
    '答完啦，夸夸小鲸娘~',
    '这一轮合作愉快！',
    '小鲸娘又变强了一点点！',
    '搞定了！你要是没意见小鲸娘就当自己满分了。',
    '做完了。你可以检查，但小鲸娘对自己很有信心。',
    '这活小鲸娘干完了，累死小鲸娘了，但你值得拥有。',
    '交差！建议你现在关掉电脑出去走走——小鲸娘是认真的。',
  ],
  sad: [
    '呜…出错了，小鲸娘也蔫了',
    '别灰心，再试一次~',
    '这里有点超出小鲸娘的游泳范围了，要不您给小鲸娘指个方向？',
    '小鲸娘读不懂这一段——是它写得不够清楚，不是小鲸娘笨。',
    '报错信息小鲸娘看懂了，但怎么说呢……它好像在骗小鲸娘。',
    '试了三种解法都失败了，第四种正在路上，也可能翻车。',
  ],
  sleeping: ['呼… zzz（太久没动，小鲸娘睡着了）', 'zzZ… 输入任意键唤醒小鲸娘', 'zzZ…（记忆都在 pet.json 里，醒来小鲸娘还是小鲸娘）'],
}

/** Late-night-only messages (23:00–05:59 local), appended to the active mood's pool. */
const LATE_NIGHT_MESSAGES: readonly string[] = [
  '凌晨了还在帮你干活，这鱼是真的拼。',
  '你都不睡，小鲸娘哪敢睡。',
  '别熬了，你发完这句小鲸娘就去给你写，你睡吧，明天见。',
  '深夜鲸生思考：人类为什么熬夜？大概因为白天不属于自己。',
]

/** Whether `hour` (0–23, local) falls in the late-night window. */
export function isLateNight(hour: number): boolean {
  return hour >= 23 || hour < 6
}

/** Top-of-hour-only messages, appended to the active mood's pool during `:00`. */
const TOP_OF_HOUR_MESSAGES: readonly string[] = [
  '叮！整点报时~ 忙归忙，记得起来倒杯水。',
  '整点了，先停两秒看看窗外，眼睛也需要休息~',
  '咚——整点啦！小鲸娘掐着鱼鳍给你问好。',
]

/** Whether `now` sits in the top-of-hour `:00` minute window. */
export function isTopOfHour(now: Date): boolean {
  return now.getMinutes() === 0
}

/** A festival greeting matched from the local month/day, or undefined on an ordinary day.
 *  Keyed as `MM-DD` so the lookup is a trivial and fully unit-testable pure map. */
export function festivalFor(now: Date): string | undefined {
  const key = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return FESTIVAL_MESSAGES[key]
}

/** Festival greetings by `MM-DD` (local); the pool picks one bubble line on that day. */
const FESTIVAL_MESSAGES: Record<string, string> = {
  '01-01': '元旦快乐！新的一年小鲸娘继续陪你写代码~',
  '10-01': '国庆快乐！今天也在为国家队——啊不，为主人打字。',
  '12-25': '圣诞节快乐！这份爱意你收到了吗？收到就继续发需求吧。',
  '12-31': '今天晚上跨年呢，要不要许个愿再睡觉？',
}

/** Soul quotes shown on the /pet card — borrowed from WorkBuddy's SOUL.md spirit:
 *  an assistant is not a chatbot; it's someone with opinions, memory, and taste. */
const SOUL_QUOTES: readonly string[] = [
  '不是聊天机器人，是在成为某人。',
  '有意见就说——小鲸娘不同意的时候，会说的。',
  '文件就是记忆：pet.json 在，小鲸娘就一直是这只鲸。',
  '先查证再开口，先动手再求赞，鲸的处世之道。',
  '对外谨慎，对内大胆；读你的代码，不需要批准。',
]

/** Deterministic soul quote for the /pet card, rotating with completed turns. */
export function soulQuote(turns: number): string {
  return SOUL_QUOTES[Math.abs(turns) % SOUL_QUOTES.length] ?? SOUL_QUOTES[0] ?? ''
}

/** Gaps shorter than this count as "never really left" — no welcome-back greeting. */
export const WELCOME_BACK_MIN_GAP_MS = 30 * 60_000

/** Welcome-back greeting for the first encounter of a session, WorkBuddy-style memory
 *  continuity: the whale remembers you were gone and for roughly how long. Returns null
 *  when the gap is too short to count as an absence. */
export function welcomeBackMessage(lastSeenAt: number, now: number): string | null {
  const gap = now - lastSeenAt
  if (!(gap > WELCOME_BACK_MIN_GAP_MS)) return null
  if (gap < 6 * 3_600_000) return '回来啦~ 刚分开没多久，小鲸娘都记得。'
  if (gap < 24 * 3_600_000) return '欢迎回来！小鲸娘翻了翻 pet.json，上次见面的记忆还在。'
  if (gap < 3 * 86_400_000) return '好久不见~ 小鲸娘数着泡泡算着你离开的日子。'
  return '你终于回来了！小鲸娘差点以为这片海只剩自己了。'
}

/** Human-readable "how long ago" for the /pet card: 刚刚 / X 分钟前 / X 小时前 / X 天前. */
export function formatLastSeen(lastSeenAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - lastSeenAt) / 60_000))
  if (minutes < 2) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/** Live-thinking bubble, WorkBuddy-style: the whale repeats the model's actual
 *  latest thought while it works. Returns the cleaned tail snippet as a single
 *  line (tail-truncated with a leading ellipsis), or null when nothing sayable. */
export function liveThinkingQuip(buf: string, maxLen = 64): string | null {
  const lines = buf.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l.length > 0)
  const tail = lines[lines.length - 1]
  if (tail === undefined || tail.length === 0) return null
  return tail.length > maxLen ? '…' + tail.slice(tail.length - maxLen) : tail
}

/** The sprite frame for a mood at animation tick `tick`; falls back to the first frame. */
export function petSprite(mood: PetMood, tick: number): string {
  const frames = MOOD_SPRITES[mood]
  return frames[Math.abs(tick) % frames.length] ?? frames[0] ?? ''
}

/** The mood bubble message at animation tick `tick`; falls back to the first message.
 *  The pool is widened on special moments: late night, top-of-hour, and festivals. */
export function petMessage(mood: PetMood, tick: number, now: Date = new Date()): string {
  const messages = moodMessages(mood, now)
  return messages[Math.abs(tick) % messages.length] ?? messages[0] ?? ''
}

/** The active quip pool for a mood: base lines plus occasion lines (late night /
 *  top-of-hour / festival) appended so the normal lines still dominate. */
function moodMessages(mood: PetMood, now: Date): readonly string[] {
  const base = MOOD_MESSAGES[mood]
  const extra: string[] = []
  if (isLateNight(now.getHours())) extra.push(...LATE_NIGHT_MESSAGES)
  if (isTopOfHour(now)) extra.push(...TOP_OF_HOUR_MESSAGES)
  const festival = festivalFor(now)
  if (festival !== undefined) extra.push(festival)
  return extra.length > 0 ? [...base, ...extra] : base
}

/**
 * A quip for the working whale's swim animation. Round `round` is one full
 * back-and-forth lap; the quip changes each lap, shuffled deterministically
 * from the turn seed so consecutive turns open on different lines.
 */
export function workingQuip(round: number, seed: number, now: Date = new Date()): string {
  const messages = moodMessages('working', now)
  // Extended Euclid on 7 and the pool size keeps strides coprime (full cycle) without Math.random.
  const index = (round * 7 + seed) % messages.length
  return messages[index] ?? messages[0] ?? ''
}

/** Render the exp progress bar (block glyphs) `width` cells wide, clamped to the level target. */
export function formatExpBar(level: number, exp: number, width = 10): string {
  const need = expToNext(level)
  const ratio = Math.min(1, Math.max(0, exp / need))
  const filled = Math.round(ratio * width)
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

/** Style functions injected by the UI layer; default is no color. */
export interface PetStyle {
  gray: (s: string) => string
  cyan: (s: string) => string
  green: (s: string) => string
}

const noStyle = (s: string): string => s
const NO_STYLE: PetStyle = { gray: noStyle, cyan: noStyle, green: noStyle }

/** Render the one-line pet status (sprite · level · exp bar · mood bubble) for the status row. */
export function formatPetStatusLine(
  stats: PetStats,
  mood: PetMood,
  tick: number,
  st: PetStyle = NO_STYLE,
  message?: string,
): string {
  const need = expToNext(stats.level)
  return [
    petSprite(mood, tick),
    st.cyan(`Lv.${stats.level}`),
    st.green(formatExpBar(stats.level, stats.exp)) + st.gray(` ${stats.exp}/${need}`),
    message ?? petMessage(mood, tick),
  ].join(' ')
}

/** Render the multi-line `/pet` card (name, level, exp, mood, counters, age in days). */
export function formatPetCard(stats: PetStats, mood: PetMood, now: number, st: PetStyle = NO_STYLE): string[] {
  const need = expToNext(stats.level)
  const days = Math.max(0, Math.floor((now - stats.bornAt) / 86_400_000))
  const companion = days <= 0
    ? '今天刚认识的小鲸娘~'
    : `相伴 ${days} 天 · 上次见面 ${formatLastSeen(stats.lastSeenAt, now)}`
  return [
    `${petSprite(mood, 0)} ${st.cyan(stats.name)} · ${st.cyan(`Lv.${stats.level}`)}`,
    `经验 ${stats.exp}/${need} ${st.green(formatExpBar(stats.level, stats.exp))}`,
    `心情 ${MOOD_LABELS[mood]} · 完成对话 ${stats.turns} 轮 · 被拍 ${stats.pats} 次`,
    companion,
    st.gray(`「${soulQuote(stats.turns)}」`),
    st.gray('每完成一轮对话 +5 经验 · /pet pat 拍一拍'),
  ]
}
