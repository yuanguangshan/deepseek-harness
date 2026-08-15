/**
 * dsh-repl TTS — Edge TTS synthesis + local playback for the TUI REPL.
 *
 * Pure logic (worker template, text cleanup, playback lookup) lives here so it
 * is independently unit-testable. The screen glue (a /tts command, automatic
 * read-aloud of assistant replies) stays in tui-repl.ts. The synthesis worker
 * is adapted (MIT) from `dsh-plugin-tts` (github.com/1624318455/dsh-plugin-tts):
 * a zero-dependency Edge TTS worker mirroring node-edge-tts@1.2.10
 * (Sec-MS-GEC query-param protocol over the Bing read-aloud WSS endpoint).
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** The zero-dependency Edge TTS worker script (kept self-contained, run via `node -e`). */
export const TTS_WORKER_SRC = `// edge-tts-worker — zero-dependency Edge TTS synthesis (Node >= 22).
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const WINDOWS_FILE_TIME_EPOCH = 11644473600n;
const WSS_BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const CRLF = String.fromCharCode(13, 10);
function generateSecMsGecToken() {
  const ticks = BigInt(Math.floor(Date.now() / 1000) + Number(WINDOWS_FILE_TIME_EPOCH)) * 10000000n;
  const roundedTicks = ticks - (ticks % 3000000000n);
  const hash = crypto.createHash('sha256');
  hash.update(String(roundedTicks) + TRUSTED_CLIENT_TOKEN, 'ascii');
  return hash.digest('hex').toUpperCase();
}
function readStdin() {
  return new Promise(function (resolve, reject) {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function (c) { data += c; });
    process.stdin.on('end', function () { resolve(data); });
    process.stdin.on('error', reject);
  });
}
function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function fail(msg) {
  console.error('ERR ' + msg);
  process.exit(1);
}
function synthesizeOnce(voice, text, outPath, lang, rate, pitch, volume) {
  return new Promise(function (resolve, reject) {
    const secMsGec = generateSecMsGecToken();
    const url = WSS_BASE + '?TrustedClientToken=' + TRUSTED_CLIENT_TOKEN + '&Sec-MS-GEC=' + secMsGec + '&Sec-MS-GEC-Version=1-' + CHROMIUM_FULL_VERSION;
    const ws = new WebSocket(url, {
      headers: {
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    ws.binaryType = 'arraybuffer';
    const chunks = [];
    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      const buf = Buffer.concat(chunks);
      if (buf.length < 100) {
        try { ws.close(); } catch (e) {}
        reject('audio too small: ' + buf.length);
        return;
      }
      try {
        fs.writeFileSync(outPath, buf);
        try { ws.close(); } catch (e) {}
        resolve(buf.length);
      } catch (e) {
        reject('write ' + e.message);
      }
    }
    ws.onerror = function (e) {
      reject('websocket error: ' + (e && e.message ? e.message : String(e)));
    };
    ws.onclose = function (e) {
      if (!settled) reject('closed early code=' + e.code + ' reason=' + e.reason);
    };
    ws.onmessage = function (event) {
      if (settled) return;
      if (typeof event.data === 'string') {
        if (event.data.indexOf('Path:turn.end') >= 0) { finish(); return; }
        return;
      }
      const raw = Buffer.from(event.data);
      const marker = Buffer.from('Path:audio' + CRLF);
      const idx = raw.indexOf(marker);
      if (idx >= 0) {
        const body = raw.subarray(idx + marker.length);
        if (body.length > 0) chunks.push(body);
      } else if (raw.length > 0) {
        chunks.push(raw);
      }
    };
    ws.onopen = function () {
      const requestId = crypto.randomBytes(16).toString('hex');
      const speechConfig = { context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } };
      const ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="' + lang + '">' + '<voice name="' + xmlEscape(voice) + '">' + '<prosody rate="' + xmlEscape(rate) + '" pitch="' + xmlEscape(pitch) + '" volume="' + xmlEscape(volume) + '">' + xmlEscape(text) + '</prosody></voice></speak>';
      ws.send('Content-Type:application/json; charset=utf-8' + CRLF + 'Path:speech.config' + CRLF + CRLF + JSON.stringify(speechConfig));
      ws.send('X-RequestId:' + requestId + CRLF + 'Content-Type:application/ssml+xml' + CRLF + 'Path:ssml' + CRLF + CRLF + ssml);
    };
    setTimeout(function () {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch (e) {}
        reject('timeout');
      }
    }, 60000);
  });
}
function findVoiceArgs() {
  const args = process.argv;
  const out = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--' || a === '-e') continue;
    if (a.indexOf('.cjs') >= 0 || a.indexOf('.mjs') >= 0 || a.indexOf('edge-tts-worker') >= 0) continue;
    out.push(a);
  }
  return out;
}
async function main() {
  const args = findVoiceArgs();
  const voice = args[0] || 'zh-CN-XiaoxuanNeural';
  const rate = args[1] || 'default';
  const pitch = args[2] || 'default';
  const volume = args[3] || 'default';
  const text = (await readStdin()).trim();
  if (!text) return fail('empty text');
  const vparts = String(voice).split('-');
  const lang = (vparts.length >= 2 ? vparts[0] + '-' + vparts[1] : 'zh-CN');
  const outPath = path.join(os.tmpdir(), 'dsh-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.mp3');
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const size = await synthesizeOnce(voice, text, outPath, lang, rate, pitch, volume);
      console.log('OK ' + outPath);
      console.log('SIZE ' + size);
      process.exit(0);
    } catch (e) {
      lastErr = e;
      const msg = String(e);
      if (msg.indexOf('1006') < 0) break;
    }
  }
  return fail(String(lastErr));
}
main().catch(function (e) {
  console.error('ERR fatal: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
`; // oxlint-disable-line @stylistic/semi -- a template-string terminator, not a statement

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
    const child = spawn(process.execPath, ['-e', TTS_WORKER_SRC, '--', voice, 'default', 'default', 'default'], {
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
