/**
 * TUI long-term memory — a self-contained port of the memory core from
 * `dsh-memory-evolve` adapted to the REPL (no `agent` object; project tracks
 * key on the workspace `cwd`).
 *
 * Five tracks, stored as plain markdown in `~/.dsh-repl/memory/` (override
 * with DSH_REPL_MEMORY_DIR), so the global tracks naturally survive across
 * sessions and projects:
 *
 *   - memory   → MEMORY.md                     (long-term memory, cross-project)
 *   - user     → USER.md                       (user profile, cross-project)
 *   - daily    → daily/YYYY-MM-DD.md           (per-day log, project-tagged)
 *   - project  → projects/<hash>/MEMORY.md     (per-project log)
 *   - key      → projects/<hash>/KEY.md        (project key facts, injected)
 *
 * Only pure logic lives here (entry parse/serialize, idempotent date/git
 * stamps, snapshot rendering for prompt injection); the terminal glue
 * (commands, turn hooks) stays in tui-repl.ts.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Entry separator inside each track file. */
export const ENTRY_DELIMITER = '\n§\n'

/** The five memory tracks. */
export type MemoryTarget = 'memory' | 'user' | 'daily' | 'project' | 'key'

/** A memory store rooted at `dir`. */
export interface MemoryConfig {
  /** Root memory directory (global tracks live here directly; project tracks under projects/<hash>). */
  dir: string
  /** Stamp entries with a `[YYYY-MM-DD] ` prefix on add (idempotent). */
  entryDatePrefix?: boolean
  /** Allow `[branch:<name>]` tags in project key entries (git-branch scoping). Default true. */
  keyBranchFilter?: boolean
}

const DEFAULT_CONFIG: Required<Omit<MemoryConfig, 'dir'>> = { entryDatePrefix: true, keyBranchFilter: true }

/** Resolve the memory directory (DSH_REPL_MEMORY_DIR override, else ~/.dsh-repl/memory). */
export function memoryDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DSH_REPL_MEMORY_DIR
  if (override !== undefined && override.trim() !== '') return override
  return join(homedir(), '.dsh-repl', 'memory')
}

/** Stable per-workspace project id from a cwd. */
export function projectHash(cwd: string): string {
  const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12)
}

/** Last path segment of a cwd (used as the human project label). */
export function projectLabel(cwd: string): string {
  const parts = cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

/** Resolve a track to its { dir, file } location. Returns undefined when the
 *  project track has no cwd to pin it to. */
export function locate(dir: string, target: MemoryTarget, cwd?: string): { dir: string; file: string } | undefined {
  switch (target) {
    case 'memory':
      return { dir, file: 'MEMORY.md' }
    case 'user':
      return { dir, file: 'USER.md' }
    case 'daily':
      return { dir: join(dir, 'daily'), file: `${todayStamp()}.md` }
    case 'project':
    case 'key':
      if (cwd === undefined || cwd === '') return undefined
      return { dir: join(dir, 'projects', projectHash(cwd)), file: target === 'key' ? 'KEY.md' : 'MEMORY.md' }
  }
}

/** `YYYY-MM-DD` for the current local date. */
export function todayStamp(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** `HH:MM` local time, for daily-log entry stamps. */
export function timeStamp(now: Date = new Date()): string {
  const h = String(now.getHours()).padStart(2, '0')
  const m = String(now.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

/** Split a track file's text into entries (ignoring blank lines between separators). */
export function parseEntries(text: string): string[] {
  return text
    .split(ENTRY_DELIMITER)
    .map(e => e.trim())
    .filter(e => e !== '')
}
/** Serialize entries back to a track file. */
export function serializeEntries(entries: readonly string[]): string {
  return entries.join(ENTRY_DELIMITER) + (entries.length > 0 ? '\n' : '')
}

/** The current git branch of `cwd`, or undefined when not in a git worktree. */
export function gitBranch(cwd: string): string | undefined {
  try {
    return execFileSync('git', ['branch', '--show-current'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}

/** The branch scope of a `[branch:<names>]` tag on an entry: a sorted list, or
 *  null when the entry carries none (meaning "all branches"). */
export function parseEntryBranches(entry: string): string[] | null {
  const m = entry.match(/\[branch:([^\]]*)\]/)
  if (m === null) return null
  // The regex guarantees group 1 exists when `m` is non-null, so the nullish
  // fallback only satisfies noUncheckedIndexedAccess and never runs at runtime.
  /* v8 ignore next */
  const names = (m[1] ?? '').split(',').map(s => s.trim()).filter(s => s !== '')
  return names.length > 0 ? [...new Set(names)].sort() : null
}

/** Stable, portable brief truncation for very long entries in the snapshot. */
export function clamp(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/* ------------------------------------------------------------------------- *
 * Entry stamping (date prefix + program-scoped git tags), kept pure.
 * ------------------------------------------------------------------------- */

/** Strip a leading date-like prefix `[YYYY-MM-DD ...]` (writers don't know the
 *  real date; the canonical program stamp wins). */
function stripLeadingDate(content: string): string {
  return content.replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/, '')
}

/** Strip a hand-written `[git branch]` tag (program-owned, model doesn't know it). */
function stripLeadingGitTag(content: string): string {
  return content.replace(/^\[git [^\]]+\]\s*/, '')
}

function stampLongTerm(content: string, now: Date): string {
  if (/^\[\d{4}-\d{2}-\d{2}\]\s/.test(content)) return content
  return `[${todayStamp(now)}] ${content}`
}

function stampProject(content: string, now: Date): string {
  return `[${todayStamp(now)} ${timeStamp(now)}] ${content}`
}

export interface StampedEntry {
  /** The stamped entry text, ready to persist. */
  readonly stamped: string
  /** A `[git <branch>] ` tag to prepend for project/daily entries, or ''. */
  readonly gitTag: string
}

/** Stamp a raw entry for the given track. Pure; caller supplies cwd for the
 *  project/daily git tag and the project label for daily entries. */
export function stampEntry(target: MemoryTarget, content: string, cwd: string | undefined, now: Date = new Date(), config: Required<Omit<MemoryConfig, 'dir'>> = DEFAULT_CONFIG): StampedEntry {
  const trimmed = content.trim()
  const git = cwd !== undefined ? gitBranch(cwd) : undefined
  const gitTag = git !== undefined ? `[git ${git}] ` : ''

  if (target === 'daily') {
    const labelTag = cwd !== undefined ? `[${projectLabel(cwd)}] ` : ''
    const stripped = stripLeadingGitTag(stripLeadingDate(trimmed))
    return { stamped: `[${timeStamp(now)}] ${gitTag}${labelTag}${stripped}`, gitTag }
  }

  if (target === 'project' || target === 'key') {
    const stripped = stripLeadingGitTag(stripLeadingDate(trimmed))
    return { stamped: `${gitTag}${stampProject(stripped, now)}`, gitTag }
  }

  // Long-term tracks (memory / user): date prefix only, no git tag.
  return { stamped: config.entryDatePrefix ? stampLongTerm(trimmed, now) : trimmed, gitTag: '' }
}

/* ------------------------------------------------------------------------- *
 * The store.
 * ------------------------------------------------------------------------- */

export class MemoryStore {
  readonly dir: string
  readonly entryDatePrefix: boolean
  readonly keyBranchFilter: boolean

  constructor(config: MemoryConfig) {
    this.dir = config.dir
    this.entryDatePrefix = config.entryDatePrefix ?? DEFAULT_CONFIG.entryDatePrefix
    this.keyBranchFilter = config.keyBranchFilter ?? DEFAULT_CONFIG.keyBranchFilter
  }

  /** The track file's raw text (empty when the file does not exist). */
  readRaw(target: MemoryTarget, cwd?: string): string {
    const loc = locate(this.dir, target, cwd)
    if (loc === undefined) return ''
    const path = join(loc.dir, loc.file)
    if (!existsSync(path)) return ''
    return readFileSync(path, 'utf8')
  }

  /** All entries of a track, in order. For `key`, filtered to the git-branch
   *  scope when keyBranchFilter is on and the workspace is a git worktree. */
  entriesOf(target: MemoryTarget, cwd?: string): string[] {
    const entries = parseEntries(this.readRaw(target, cwd))
    if (target !== 'key' || !this.keyBranchFilter || cwd === undefined) return entries
    const branch = gitBranch(cwd)
    if (branch === undefined) return entries
    return entries.filter((entry) => {
      const scope = parseEntryBranches(entry)
      return scope === null || scope.includes(branch)
    })
  }

  /** Replace the whole track content with `entries`. Ensures the parent dir exists. */
  write(target: MemoryTarget, entries: readonly string[], cwd?: string): void {
    const loc = locate(this.dir, target, cwd)
    if (loc === undefined) return
    mkdirSync(loc.dir, { recursive: true })
    writeFileSync(join(loc.dir, loc.file), serializeEntries(entries), 'utf8')
  }

  /** Add `content` to a track (date-stamped where appropriate); idempotent by exact duplicate. */
  add(target: MemoryTarget, content: string, cwd?: string, now: Date = new Date()): void {
    const cfg = { entryDatePrefix: this.entryDatePrefix, keyBranchFilter: this.keyBranchFilter }
    const { stamped } = stampEntry(target, content, cwd, now, cfg)
    const entries = parseEntries(this.readRaw(target, cwd))
    if (entries.includes(stamped)) return
    entries.push(stamped)
    this.write(target, entries, cwd)
  }

  /** Remove entries whose text contains `needle`; returns how many were removed. */
  remove(target: MemoryTarget, needle: string, cwd?: string): number {
    const before = parseEntries(this.readRaw(target, cwd))
    const kept = before.filter(entry => !entry.includes(needle))
    if (kept.length === before.length) return 0
    this.write(target, kept, cwd)
    return before.length - kept.length
  }

  /** Clear a whole track: the current daily file *and every historical one*. */
  clear(target: MemoryTarget, cwd?: string): void {
    if (target === 'daily') {
      const dir = join(this.dir, 'daily')
      if (existsSync(dir)) {
        for (const f of readdirSync(dir)) {
          if (f.endsWith('.md')) rmSync(join(dir, f), { force: true })
        }
      }
      return
    }
    this.write(target, [], cwd)
  }

  /** The list of dates that have a daily log (newest first). */
  dailyDates(): string[] {
    const dir = join(this.dir, 'daily')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''))
      .sort().reverse()
  }
}

/* ------------------------------------------------------------------------- *
 * Snapshot rendering — the markdown block injected into the model prompt so
 * the agent "sees" long-term memory across sessions and projects.
 * ------------------------------------------------------------------------- */

export interface MemorySnapshotOptions {
  /** Long-term track entries to surface (already branch-filtered for key). */
  memory?: readonly string[]
  /** User-profile entries. */
  user?: readonly string[]
  /** Project key entries (already branch-filtered). */
  key?: readonly string[]
  /** The git branch the workspace is on (for the injected branch hint). */
  branch?: string | undefined
  /** Cap per-entry length in the snapshot. */
  maxEntry?: number
}

/**
 * Render the memory snapshot to prepend to the next user prompt. Pure — the
 * caller decides which entries to feed (via {@link MemoryStore.entriesOf}).
 * Returns an empty string when there is nothing to show, so injection is
 * a no-op until memory exists.
 */
export function renderMemorySnapshot(opts: MemorySnapshotOptions): string {
  const cap = opts.maxEntry ?? 160
  const parts: string[] = []
  const mem = (opts.memory ?? []).slice(0, 12)
  const user = (opts.user ?? []).slice(0, 8)
  const key = (opts.key ?? []).slice(0, 12)

  if (mem.length > 0) {
    parts.push(`## 长期记忆（跨会话，始终遵守）\n${mem.map(e => `- ${clamp(e, cap)}`).join('\n')}`)
  }
  if (user.length > 0) {
    parts.push(`## 用户档案\n${user.map(e => `- ${clamp(e, cap)}`).join('\n')}`)
  }
  if (key.length > 0) {
    const branchHint = opts.branch !== undefined ? `（当前 git 分支：${opts.branch}）` : ''
    parts.push(`## 本项目的关键记忆${branchHint}\n${key.map(e => `- ${clamp(e, cap)}`).join('\n')}`)
  }
  return parts.join('\n\n')
}
