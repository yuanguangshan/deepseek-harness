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
}

/** On-disk pet file version. */
export const PET_FILE_VERSION = 1

/** Exp granted per completed conversation turn. */
export const EXP_PER_TURN = 5

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
  return { name: '小鲸娘', level: 1, exp: 0, pats: 0, turns: 0, bornAt: now }
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
  idle: ['鲸在这里陪你写代码~', '有问题尽管问~', '今天也要加油鸭~', '鲸会随对话成长哦~'],
  working: ['思考中…', '鲸鲸努力中…'],
  happy: ['答完啦，夸夸鲸~', '这一轮合作愉快！', '鲸又变强了一点点！'],
  sad: ['呜…出错了，鲸也蔫了', '别灰心，再试一次~'],
  sleeping: ['呼… zzz（太久没动，鲸睡着了）', 'zzZ… 输入任意键唤醒鲸'],
}

/** The sprite frame for a mood at animation tick `tick`; falls back to the first frame. */
export function petSprite(mood: PetMood, tick: number): string {
  const frames = MOOD_SPRITES[mood]
  return frames[Math.abs(tick) % frames.length] ?? frames[0] ?? ''
}

/** The mood bubble message at animation tick `tick`; falls back to the first message. */
export function petMessage(mood: PetMood, tick: number): string {
  const messages = MOOD_MESSAGES[mood]
  return messages[Math.abs(tick) % messages.length] ?? messages[0] ?? ''
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
  return [
    `${petSprite(mood, 0)} ${st.cyan(stats.name)} · ${st.cyan(`Lv.${stats.level}`)}`,
    `经验 ${stats.exp}/${need} ${st.green(formatExpBar(stats.level, stats.exp))}`,
    `心情 ${MOOD_LABELS[mood]} · 完成对话 ${stats.turns} 轮 · 被拍 ${stats.pats} 次`,
    days <= 0 ? '今天刚认识的鲸~' : `相伴 ${days} 天`,
    st.gray('每完成一轮对话 +5 经验 · /pet pat 拍一拍'),
  ]
}
