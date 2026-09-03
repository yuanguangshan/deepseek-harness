/**
 * Native `@file` fuzzy completion for the REPL's editor.
 *
 * The REPL relies on `@earendil-works/pi-tui` for editing, whose bundled
 * `CombinedAutocompleteProvider` only does `@file` fuzzy search when the
 * external `fd`/`fdfind` binary is available (it silently returns nothing
 * otherwise). Rather than requiring that binary, this module supplies a
 * self-contained completer: it walks the workspace with plain `readdir`,
 * fuzzy-matches entries by name/path, supports `/` directory drill-down and
 * `~/` home expansion, and escapes paths with spaces as `@"path with spaces"`.
 * It also keeps the slash-command fuzzy completion, so the editor keeps one
 * provider that understands both `@file` and `/command`.
 */

import { readdirSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** One completion row returned to the editor. */
export interface AtRow {
  readonly value: string
  readonly label: string
  readonly description?: string
}

const MAX_FUZZY_RESULTS = 20
const MAX_SCAN_DEPTH = 6 // bound recursive walk cost in large checkouts
const MAX_SCAN_ENTRIES = 5_000

/** Recursively walk the workspace, collecting visible path segments. */
function walkEntries(dirPath: string, relPrefix: string, depth: number, budget: { n: number }): string[] {
  if (depth > MAX_SCAN_DEPTH || budget.n <= 0) return []
  let dirents: Dirent[]
  try {
    dirents = readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const d of dirents) {
    if (budget.n <= 0) break
    budget.n -= 1
    if (d.name === 'node_modules' || d.name === '.git') continue
    const rel = relPrefix === '' ? d.name : `${relPrefix}/${d.name}`
    out.push(rel)
    if (d.isDirectory()) {
      out.push(...walkEntries(join(dirPath, d.name), rel, depth + 1, budget))
    }
  }
  return out
}

/** Score a path against the lowercased query (higher = better). */
function scoreEntry(name: string, query: string): number {
  const n = name.toLowerCase()
  if (n === query) return 100
  if (n.startsWith(query)) return 80
  if (n.includes(query)) return 50
  return 0
}

/** Whether `p` is a directory (or a symlink that resolves to one). */
function isDirectorySync(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * A self-contained autocomplete provider handling:
 *  - `@file` fuzzy completion against the workspace (`cwd`);
 *  - `@dir/` and `@dir/sub/` directory drill-down;
 *  - `@~/` absolute / home expansion;
 *  - `/command` fuzzy completion over the supplied slash commands.
 */
export class AtFileProvider {
  private readonly commands: readonly AtRow[]
  private readonly basePath: string

  constructor(commands: readonly AtRow[], basePath: string) {
    this.commands = commands
    this.basePath = basePath
  }

  /** Characters that should naturally trigger this provider at token boundaries. */
  readonly triggerCharacters = ['@', '/', '~']

  /** Extract the `@…` prefix before the cursor, or null when not in an @ context. */
  private atPrefix(beforeCursor: string): string | null {
    // `@"` … quoted context.
    const open = beforeCursor.indexOf('@"')
    if (open !== -1 && !beforeCursor.slice(open + 2).includes('"')) {
      return beforeCursor.slice(open)
    }
    // A token that starts with `@` at a word boundary.
    const m = /(?:^|[\s(["=,]+)(@[^\s()]*)$/.exec(beforeCursor)
    return m !== null && m[1] !== undefined ? m[1] : null
  }

  /** Slash-command fuzzy completion for the current `/cmd` token. */
  private commandSuggestions(token: string): AtRow[] | null {
    const prefix = token.slice(1).toLowerCase()
    const hits = this.commands
      .filter(c => c.value.toLowerCase().startsWith(prefix))
      .sort((a, b) => a.value.localeCompare(b.value))
    if (hits.length === 0) return null
    // Values carry the leading `/` so applying replaces the whole `/cmd` token.
    return hits.map(h => ({ value: `/${h.value}`, label: h.label, ...(h.description !== undefined ? { description: h.description } : {}) }))
  }

  /** Parse a (relative or `~/`) file prefix into an absolute base dir + query + display base. */
  private resolveRaw(raw: string): { baseDir: string; query: string; displayBase: string; scoped: boolean } {
    const slash = raw.lastIndexOf('/')
    const displayBase = slash === -1 ? '' : raw.slice(0, slash + 1)
    const query = slash === -1 ? raw : raw.slice(slash + 1)
    if (displayBase.startsWith('~/')) return { baseDir: join(homedir(), displayBase.slice(2)), query, displayBase, scoped: false }
    if (displayBase.startsWith('/')) return { baseDir: displayBase, query, displayBase, scoped: false }
    // Workspace-scoped: the subdirectory when drilling down, else the workspace root.
    return { baseDir: slash === -1 ? this.basePath : join(this.basePath, displayBase), query, displayBase, scoped: true }
  }

  /** Build rows for browsing `dir` directly (absolute path context). */
  private listDirectory(dir: string, displayPrefix: string, dirOnly: boolean): AtRow[] | null {
    let dirents: Dirent[]
    try {
      if (dirOnly && !isDirectorySync(dir)) return null
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    const rows: AtRow[] = []
    for (const d of dirents) {
      if (d.name === '.git' || d.name === 'node_modules') continue
      const sub = isDirectorySync(join(dir, d.name))
      const display = `${displayPrefix}${d.name}${sub ? '/' : ''}`
      rows.push({ value: display.includes(' ') ? `@"${display}"` : `@${display}`, label: `${d.name}${sub ? '/' : ''}`, description: display })
    }
    rows.sort((a, b) => {
      const aDir = a.value.endsWith('/')
      const bDir = b.value.endsWith('/')
      if (aDir && !bDir) return -1
      if (!aDir && bDir) return 1
      return a.label.localeCompare(b.label)
    })
    return rows.length > 0 ? rows : null
  }

  /** Collect `@file` completion rows for a raw (already un-`@`-ed) prefix. */
  private fileRows(raw: string, quoted: boolean): AtRow[] | null {
    const { baseDir, query, displayBase, scoped } = this.resolveRaw(raw)
    // Absolute / home paths: browse that directory, no whole-machine fuzzy scan.
    if (!scoped) {
      const browse = raw.endsWith('/') || query === ''
      return this.listDirectory(baseDir, displayBase, browse)
    }
    // Workspace-scoped fuzzy search over a bounded recursive walk, scoped to the
    // subdirectory when the prefix drills down (`dir/name`).
    const q = query.toLowerCase()
    const budget = { n: MAX_SCAN_ENTRIES }
    const wsRel = (sub: string): string => (displayBase === '' ? sub : `${displayBase}${sub}`)
    const all = walkEntries(baseDir, '', 0, budget).map(wsRel)
    const scored = all
      .map(rel => ({ rel, name: basename(rel), score: scoreEntry(basename(rel), q) }))
      .filter(e => e.score > 0)
      .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
    const rows: AtRow[] = []
    for (const { rel, name } of scored.slice(0, MAX_FUZZY_RESULTS)) {
      const dir = isDirectorySync(join(this.basePath, rel))
      const display = `${rel}${dir ? '/' : ''}`
      const isQuoted = quoted || display.includes(' ')
      rows.push({ value: isQuoted ? `@"${display}"` : `@${display}`, label: `${name}${dir ? '/' : ''}`, description: rel })
    }
    return rows.length > 0 ? rows : null
  }

  /** Main entry: the editor requests suggestions. Pure-sync; resolves a settled promise. */
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<{ items: AtRow[]; prefix: string } | null> {
    const line = lines[cursorLine] ?? ''
    const before = line.slice(0, cursorCol)
    const at = this.atPrefix(before)
    if (at !== null) {
      const quoted = at.startsWith('@"')
      const raw = quoted
        ? at.slice(2).replace(/"$/, '')
        : at.slice(1)
      const rows = this.fileRows(raw, quoted)
      return Promise.resolve(rows === null || rows.length === 0 ? null : { items: rows, prefix: at })
    }
    // Slash command, but only a bare `/cmd` token (not mid-sentence).
    if (!options.force && /^\/[^\s]+\s*$/.test(before) && !before.includes(' ')) {
      const rows = this.commandSuggestions(before)
      return Promise.resolve(rows === null ? null : { items: rows, prefix: before })
    }
    return Promise.resolve(null)
  }

  /** Apply a selected row by replacing the matched prefix. */
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AtRow,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const line = lines[cursorLine] ?? ''
    const cut = cursorCol - prefix.length
    const next = line.slice(0, cut) + item.value + line.slice(cursorCol)
    const nl = [...lines]
    nl[cursorLine] = next
    return { lines: nl, cursorLine, cursorCol: cut + item.value.length }
  }

  /** Tab should force file/path completion. */
  shouldTriggerFileCompletion(): boolean {
    return true
  }
}

// ---- @image attachments (disk images ride the next prompt) ----

/** Image extensions the runtime's attachment admission accepts (mirrors the wire media types). */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

/** Extension → wire media type for the attachment upload. */
const MEDIA_BY_EXTENSION: Readonly<Record<string, 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** One disk image reference parsed out of a submitted prompt. */
export interface ImageMention {
  /** Absolute path after `~` expansion and quote stripping. */
  readonly path: string
  /** The display text the mention occupied in the prompt. */
  readonly raw: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
}

/** Whether `path` names an attachable image extension. */
export function isImageExtension(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

/**
 * Extract `@image` mentions from a submitted prompt: `@shot.png`, `@dir/pic.jpg`,
 * and `@"path with spaces.png"` (the same shapes the autocomplete produces).
 * Pure text work — existence is checked by the caller at upload time. Each
 * mention is removed from the returned text (trimmed of doubled spaces) so the
 * model does not see a dangling path it cannot open.
 */
export function extractImageMentions(
  text: string,
  resolvePath: (p: string) => string = identity,
): { text: string; mentions: ImageMention[] } {
  const mentions: ImageMention[] = []
  const stripped = text.replace(/@"([^"]+)"|@([^\s()]+)/g, (whole, quoted: string | undefined, bare: string | undefined) => {
    // The regex's two alternatives are exhaustive: one of the two groups always matches.
    const rawPath = `${quoted ?? bare}`.trim()
    if (rawPath === '' || !isImageExtension(rawPath)) return whole
    const expanded = rawPath.startsWith('~/') ? join(homedir(), rawPath.slice(2)) : rawPath
    // The media table covers every IMAGE_EXTENSIONS entry, so the lookup cannot miss.
    const mediaType = MEDIA_BY_EXTENSION[rawPath.slice(rawPath.lastIndexOf('.')).toLowerCase()] as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    mentions.push({ path: resolvePath(expanded), raw: whole, mediaType })
    return ''
  })
  return { text: stripped.replace(/ {2,}/g, ' ').trim(), mentions }
}

/** Path identity used when the caller supplies no resolver. */
function identity(p: string): string {
  return p
}
