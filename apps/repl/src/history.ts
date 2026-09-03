/**
 * Historical-session scan for the REPL's `/resume` command.
 *
 * The REPL is a JSON-RPC client: it holds a live session in the runtime
 * subprocess, and `client.prompt(sessionId, ...)` resumes an existing session
 * by id (an unknown id creates it). To let the user *pick* a previous session
 * we scan the runtime's on-disk session store (`DSH_SESSION_ROOT`, default
 * `./.sessions` — the value mirrored by `examples/jsonrpc-agent/*.cordis.yml`).
 *
 * Layout: `<root>/--<projectKey(cwd)>--/<encodeSegment(id)>/session.jsonl.zstd`.
 * The first byte range is one checksummed Zstandard frame holding a single
 * `{ "type": "session", ... }` header line. Frame locations come from the
 * canonical `@deepseek-ai/dsh-session-persistence-jsonl` scanner, so the store
 * format is parsed by the same code that writes it instead of a mirrored
 * parser. The path encoders stay local mirrors — importing the canonical
 * format module at runtime would pull the cordis-backed persistence backend
 * into the standalone bundle — and `tests/history.spec.ts` pins them to the
 * canonical implementations so they cannot drift silently.
 *
 * Each scan reads at most {@link TITLE_SCAN_BUDGET} bytes of a session
 * artifact: the header is the first frame and titles live in early frames, so
 * a multi-megabyte log costs a bounded read, and the walk yields to the event
 * loop between sessions so the TUI keeps rendering. Files beyond the budget
 * fall back to `id + createdAt`.
 *
 * `listAllSessions` extends the scan across every `--…--` workspace directory
 * under the store, labelling each historical session with the `cwd` it was
 * created in — the datum a cross-workspace `/resume` handoff needs to relaunch
 * the REPL in that workspace.
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync, rmSync, type Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { scanZstdFrames } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'

// ---- canonical path encoders (mirrors dsh-session-persistence-jsonl/src/format; pinned by tests) ----

/** Escape one character the server's `encodeSegment` turns into `~XXXX`. */
function escapeUnit(code: number, ch: string): string {
  if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) return ch
  return '~' + code.toString(16).toUpperCase().padStart(4, '0')
}

/**
 * File-system-safe encoding of a session id (mirrors `encodeSegment`):
 * printable ASCII survives, everything else becomes `~XXXX` hex.
 */
export function encodeSessionId(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    // v8 ignore next -- the loop bound guarantees raw[i] is defined; the fallback is a noUncheckedIndexedAccess artifact
    out += escapeUnit(raw.charCodeAt(i), raw[i] ?? '')
  }
  return out
}

/**
 * Human-readable directory key for a project path (mirrors `projectKey`):
 * `/`, `\` and `:` collapse to `-`, unsafe code units use `~XXXX`, bounded to
 * a filesystem-safe length and wrapped in `--…--`.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** The default per-session artifact file name under a session directory. */
export const SESSION_LOG_FILE = 'session.jsonl.zstd'

// ---- frame location (canonical scanner) + decoding ----

/**
 * Frame ranges of one artifact per the canonical scanner. A corrupt or torn
 * log is a tolerated read failure, not a crash: the scanner rejects invalid
 * complete structure, and this reader answers "no metadata" instead — the
 * runtime owns repair, the picker only displays.
 */
function frameRanges(buffer: Buffer, maxFrames?: number): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  try {
    return maxFrames === undefined ? scanZstdFrames(buffer).frames : scanZstdFrames(buffer, maxFrames).frames
  } catch {
    return []
  }
}

/** Decompress one Zstandard frame (injectable so tests can force failures). */
export type FrameDecoder = (frame: Buffer) => Buffer

const nodeZstd: FrameDecoder = frame => zstdDecompressSync(frame)

/** Decompress the first header frame of a session log, or '' on any error. */
export function decodeHeaderFrame(buffer: Buffer, decode: FrameDecoder = nodeZstd): string {
  const frame = frameRanges(buffer, 1)[0]
  if (frame === undefined) return ''
  try {
    return decode(buffer.subarray(frame.start, frame.end)).toString('utf8')
  } catch {
    return ''
  }
}

// ---- session metadata parsing ----

/** The minimal session header fields the picker needs (mirrors `SessionHeader`). */
export interface SessionMeta {
  readonly id: string | undefined
  readonly createdAt: number | undefined
  readonly cwd: string | undefined
}

const NO_META: SessionMeta = { id: undefined, createdAt: undefined, cwd: undefined }

/** Parse a decoded header record (tolerant of any shape; malformed → undefined fields). */
export function parseSessionHeader(lineText: string): SessionMeta {
  if (lineText.trim() === '') return NO_META
  let parsed: unknown
  try {
    parsed = JSON.parse(lineText)
  } catch {
    return NO_META
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return NO_META
  const rec = parsed as Record<string, unknown>
  return {
    id: typeof rec.id === 'string' ? rec.id : undefined,
    createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : undefined,
    cwd: typeof rec.cwd === 'string' ? rec.cwd : undefined,
  }
}

// ---- store scanning ----

/** One selectable historical session entry. */
export interface SessionEntry {
  readonly sessionId: string
  readonly createdAt: number | undefined
  readonly cwd: string | undefined
  readonly title: string | undefined
}

/** How many compressed bytes we are willing to read and decode per session for header + title (0 = skip titles). */
export const TITLE_SCAN_BUDGET = 512 * 1024

/**
 * Session root directory (override with `DSH_SESSION_ROOT`), defaulting to a
 * `.sessions` directory under the current working directory — the same default
 * the runtime configs use, so a REPL started beside the runtime finds its logs.
 */
export function sessionRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DSH_SESSION_ROOT
  if (override !== undefined && override.trim() !== '') {
    const root = override.trim()
    return root.startsWith('/') || /^[A-Za-z]:[\\/]/.test(root) ? root : join(process.cwd(), root)
  }
  return join(process.cwd(), '.sessions')
}

/**
 * Read at most `maxBytes` from the front of a file without loading the whole
 * artifact. A missing file yields undefined; a stat/read failure mid-way does
 * too (the scan skips the session rather than failing the picker).
 */
function readPrefixSync(file: string, maxBytes: number): Buffer | undefined {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return undefined
  }
  try {
    const size = Math.max(0, fstatSync(fd).size)
    const buf = Buffer.alloc(Math.min(size, maxBytes))
    const read = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, Math.max(0, read))
  } catch {
    // v8 ignore next -- a stat/read race with the runtime's own writes; the scan simply skips the session
    return undefined
  } finally {
    closeSync(fd)
  }
}

/** Yield to the macrotask queue so a long store scan cannot starve the TUI render loop. */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

/** Scan the `--…--` workspace directory `dir` for its historical sessions, newest first. */
async function scanWorkspaceDir(dir: string, fallbackCwd: string | undefined): Promise<SessionEntry[]> {
  let dirents: Dirent[]
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const sessions: SessionEntry[] = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    const logFile = join(dir, dirent.name, SESSION_LOG_FILE)
    const ab = readPrefixSync(logFile, TITLE_SCAN_BUDGET)
    if (ab === undefined) continue
    // v8 ignore next -- an empty header string still splits to a defined [0]; the fallback is a noUncheckedIndexedAccess artifact
    const headerLine = decodeHeaderFrame(ab).split('\n')[0] ?? ''
    const meta = parseSessionHeader(headerLine)
    const sessionId = meta.id ?? dirent.name
    if (sessionId === '') continue
    const title = findTitle(ab, TITLE_SCAN_BUDGET)
    // The recorded header cwd is authoritative; a corrupt header falls back to
    // the directory-derived cwd so the picker can still route a handoff.
    sessions.push({ sessionId, createdAt: meta.createdAt, cwd: meta.cwd ?? fallbackCwd, title })
    await yieldToEventLoop()
  }
  return sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
}

/** Scan one workspace for its historical sessions, newest first. */
export async function listSessionsIn(root: string, cwd: string): Promise<SessionEntry[]> {
  return scanWorkspaceDir(join(root, projectKey(cwd)), cwd)
}

/**
 * Scan *every* workspace in the session store for its historical sessions,
 * newest first overall. This is what backs the cross-workspace `/resume`
 * picker: each archived session is labelled with the `cwd` it was created in,
 * so a handoff can re-launch the REPL in that workspace (see `resumeTo`).
 * Non-`--…--` entries (files, stray dirs) are skipped.
 */
export async function listAllSessions(env: NodeJS.ProcessEnv = process.env): Promise<SessionEntry[]> {
  const root = sessionRoot(env)
  let dirents: Dirent[]
  try {
    dirents = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const sessions: SessionEntry[] = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    const name = dirent.name
    if (!name.startsWith('--') || !name.endsWith('--')) continue
    // The `--…--` workspace key is opaque to us; per-session recorded header
    // cwd drives any handoff, so no need to decode the directory name.
    sessions.push(...await scanWorkspaceDir(join(root, name), undefined))
  }
  return sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
}

/** Resolve the session store root and scan *this* cwd's workspace. */
export async function listSessions(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Promise<SessionEntry[]> {
  return listSessionsIn(sessionRoot(env), cwd)
}

/** Outcome of one session-directory delete. */
export type DeleteSessionOutcome = 'deleted' | 'missing' | 'error'

/**
 * Delete one historical session's on-disk directory (the whole
 * `encodeSessionId(id)/` folder, log included). The delete is irreversible;
 * the caller owns the human confirmation and must never target the session
 * the live runtime is writing to. A missing directory counts as `missing`
 * (already gone), not an error.
 */
export function deleteSessionDir(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): DeleteSessionOutcome {
  const dir = join(sessionRoot(env), projectKey(cwd), encodeSessionId(sessionId))
  try {
    rmSync(dir, { recursive: true, force: false })
    return 'deleted'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return code === 'ENOENT' ? 'missing' : 'error'
  }
}

// ---- title extraction (best-effort, within a byte budget) ----

/**
 * Find the last `session/title` event title by decompressing frames up to
 * `budget` compressed bytes. Returns undefined on any failure or when the
 * budget expires before a title event is seen (the picker then shows the id).
 * A title may be set by a later event than the first prompt, so we want the
 * *last* one; scanning from the front keeps reading cheap.
 */
export function findTitle(buffer: Buffer, budget = TITLE_SCAN_BUDGET, decode: FrameDecoder = nodeZstd): string | undefined {
  let title: string | undefined
  let consumed = 0
  for (const range of frameRanges(buffer)) {
    if (consumed >= budget) break
    let decoded: Buffer
    try {
      decoded = decode(buffer.subarray(range.start, range.end))
    } catch {
      break
    }
    for (const line of decoded.toString('utf8').split('\n')) {
      if (line.trim() === '') continue
      const t = titleOfLine(line)
      if (t !== undefined) title = t
    }
    consumed = range.end
  }
  return title
}

/** Read the title out of one JSONL line (a `session/title` event) if present. */
function titleOfLine(line: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const rec = parsed as Record<string, unknown>
  if (rec.type !== 'session/title') return undefined
  const data = rec.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const title = (data as Record<string, unknown>).title
  return typeof title === 'string' && title.trim() !== '' ? title : undefined
}

// ---- event replay ----

/** One decoded event from a persisted session log, shaped like a raw `session.event`. */
export interface SessionLogEvent {
  readonly type: string
  readonly time: number
  readonly data?: unknown
}

/** Parse the session events out of one decoded frame's JSONL text (tolerant of junk lines). */
function parseEventLines(text: string): SessionLogEvent[] {
  const events: SessionLogEvent[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const rec = parsed as Record<string, unknown>
    if (typeof rec.type !== 'string') continue
    const event: SessionLogEvent = {
      type: rec.type,
      time: typeof rec.time === 'number' ? rec.time : 0,
      ...('data' in rec ? { data: rec.data } : {}),
    }
    events.push(event)
  }
  return events
}

/** Decode the full event log of one persisted session, in log order. */
export function readSessionEvents(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): SessionLogEvent[] {
  const file = join(sessionRoot(env), projectKey(cwd), encodeSessionId(sessionId), SESSION_LOG_FILE)
  let ab: Buffer
  try {
    ab = readFileSync(file)
  } catch {
    return []
  }
  const events: SessionLogEvent[] = []
  for (const range of frameRanges(ab)) {
    let decoded: Buffer
    try {
      decoded = nodeZstd(ab.subarray(range.start, range.end))
    } catch {
      break
    }
    events.push(...parseEventLines(decoded.toString('utf8')))
  }
  return events
}

/**
 * Extract the human user's text from a `user/message` event, or undefined when
 * it carries no displayable user text (system injections such as skill catalogs,
 * system reminders, or empty content are skipped). Only `source.kind === 'user'`
 * records are surfaced so a resumed transcript shows real turns, not framework
 * messages.
 */
export function userMessageText(event: SessionLogEvent): string | undefined {
  const data = event.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const rec = data as Record<string, unknown>
  const source = rec.source
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return undefined
  if ((source as Record<string, unknown>).kind !== 'user') return undefined
  const content = rec.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  const text = parts.join('').trim()
  return text === '' ? undefined : text
}

// ---- display formatting (pure, style-injectable) ----

/** Date/label style helpers injected by the UI layer; default is no color. */
export interface HistoryStyle {
  gray: (s: string) => string
  cyan: (s: string) => string
  green: (s: string) => string
  yellow: (s: string) => string
}

const noStyle = (s: string): string => s
const NO_STYLE: HistoryStyle = { gray: noStyle, cyan: noStyle, green: noStyle, yellow: noStyle }

/** Format a millisecond epoch as `YYYY-MM-DD HH:mm`. */
export function formatCreatedAt(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '未知时间'
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** A one-line picker description for a session (id + time; title when known). */
export function describeSession(entry: SessionEntry, st: HistoryStyle = NO_STYLE): string {
  const time = st.gray(formatCreatedAt(entry.createdAt))
  if (entry.title !== undefined && entry.title !== '') {
    return `${st.green(entry.title)}  ${time}`
  }
  return `${st.cyan(entry.sessionId)}  ${time}`
}
