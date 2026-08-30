/**
 * dsh-repl TTS — Edge TTS synthesis + local playback for the TUI REPL.
 *
 * Pure logic (text cleanup, playback lookup) lives here so it is independently
 * unit-testable. The screen glue (a /tts command, automatic read-aloud of
 * assistant replies) stays in tui-repl.ts. The synthesis worker is adapted
 * (MIT) from `dsh-plugin-tts` (github.com/1624318455/dsh-plugin-tts): a
 * zero-dependency Edge TTS worker mirroring node-edge-tts@1.2.10 (Sec-MS-GEC
 * query-param protocol over the Bing read-aloud WSS endpoint), shipped as a
 * real script file at the package root so it stays lintable and testable.
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { delimiter, join } from 'node:path'

/**
 * The bundled worker script, resolved beside this module: `src/tts.ts` in a
 * source checkout, the package root in the standalone install (`tts-worker.cjs`
 * ships in the published `files`).
 */
const TTS_WORKER_FILE = fileURLToPath(new URL('../tts-worker.cjs', import.meta.url))

/** Default Edge TTS voice (晓萱, warm female Chinese voice). */
export const DEFAULT_VOICE = 'zh-CN-XiaoxuanNeural'

/** Strip ANSI escapes and the 🐳 / 你 prefixes so spoken text is clean prose. */
export function cleanSpokenText(text: string): string {
  return text
    .replace(/\x1B\[[0-9;]*[mK]/g, '')   // ANSI SGR / EL
    .replace(/^\s*🐳\s*/, '')            // whale prefix
    .replace(/^你\s+/, '')               // user bubble "你 <text>" label (needs a space)
    .replace(/\s+/g, ' ')
    .trim()
}

/** A player command; `args(file)` yields the argv after the player name. */
export interface Player { readonly name: string; readonly args: (file: string) => string[] }

/** Recognized local audio players, best-match first, by platform. */
const PLAYERS: ReadonlyArray<Player> = [
  { name: 'afplay', args: file => [file] },            // macOS built-in
  { name: 'ffplay', args: file => ['-nodisp', '-autoexit', '-loglevel', 'quiet', file] },
  { name: 'paplay', args: file => [file] },            // Linux/PulseAudio
]

/**
 * Pick the best available local player for a synthesized file, or null when none
 * is installed. `exists` is injectable for tests (defaults to fs.existsSync over
 * PATH + cwd candidates).
 */
export function resolvePlayer(
  exists: (candidate: string) => boolean = p => existsSync(p),
  files: ReadonlyArray<Player> = PLAYERS,
): Player | null {
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const player of files) {
    for (const dir of pathDirs) {
      if (exists(join(dir, player.name))) return player
    }
    if (exists(player.name)) return player
  }
  return null
}

/** Synthesize `text` to a local MP3 and resolve with its path. */
export function synthesize(text: string, voice = DEFAULT_VOICE): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TTS_WORKER_FILE, voice, 'default', 'default', 'default'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += String(d) })
    child.stderr.on('data', (d) => { stderr += String(d) })
    const timer = setTimeout(() => { try { child.kill() } catch { /* already gone */ } }, 65_000)
    child.stdin.write(text)
    child.stdin.end()
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`TTS 合成失败 (code=${code}): ${stderr.trim()}`))
        return
      }
      const m = stdout.match(/^OK (.+)$/m)
      const outPath = m?.[1]
      if (outPath === undefined) { reject(new Error(`TTS 未返回音频: ${stdout.trim()}`)); return }
      resolve(outPath.trim())
    })
  })
}

/** Play a local audio file with the best available player; resolves on player exit. */
export function play(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const player = resolvePlayer()
    if (player === null) {
      reject(new Error('未找到可用的本地播放器（afplay/ffplay/paplay）'))
      return
    }
    const child = spawn(player.name, player.args(file), { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => { err += String(d) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${player.name} 播放失败 (code=${code}): ${err.trim()}`))
      else resolve()
    })
  })
}

/**
 * Best-effort removal of a synthesized temp file.
 *
 * `remove` is injectable for tests (defaults to synchronous fs.rmSync guarded by
 * an existsSync probe, wrapped in a Promise so the caller can await it). A
 * failed removal is swallowed so cleanup never interferes with an already-
 * resolved playback — the caller can await it without worrying about rejection.
 */
export async function deleteSynthFile(
  file: string,
  remove: (path: string) => Promise<void> | PromiseLike<void> = (p) => {
    if (existsSync(p)) rmSync(p, { force: true })
    return Promise.resolve()
  },
): Promise<void> {
  try {
    await remove(file)
  } catch {
    // Best-effort: a leftover temp clip is preferable to turning a successful
    // read-aloud into a failure just because OS cleanup raced us.
  }
}

/** Convenience wrapper: synthesize then play, resolving with the MP3 path. */
export async function speak(text: string, voice = DEFAULT_VOICE): Promise<string> {
  const file = await synthesize(text, voice)
  try {
    await play(file)
    return file
  } finally {
    // Don't let a synthesized clip leak into the OS temp dir on every read-aloud.
    await deleteSynthFile(file)
  }
}
