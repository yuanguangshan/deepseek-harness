"use strict";
// edge-tts-worker — zero-dependency Edge TTS synthesis (Node >= 22).
//
// Adapted (MIT) from `dsh-plugin-tts` (github.com/1624318455/dsh-plugin-tts),
// mirroring node-edge-tts@1.2.10: the Sec-MS-GEC query-param protocol over the
// Bing read-aloud WSS endpoint. dsh-repl's tts.ts spawns this file under the
// current Node, pipes the text on stdin, and reads `OK <path>` / `SIZE <n>` on
// stdout (`ERR <message>` on stderr with exit 1 on failure).
//
// Usage: node tts-worker.cjs [voice] [rate] [pitch] [volume] < text
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const WINDOWS_FILE_TIME_EPOCH = 11644473600n;
const WSS_BASE = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const CRLF = String.fromCharCode(13, 10);

/**
 * The Sec-MS-GEC token: SHA-256 of the wall clock rounded down to a 5-minute
 * tick plus the trusted client token. `now` is injectable (ms epoch) so tests
 * can pin the hash input.
 */
function generateSecMsGecToken(now = Date.now()) {
  const ticks = BigInt(Math.floor(now / 1000) + Number(WINDOWS_FILE_TIME_EPOCH)) * 10000000n;
  const roundedTicks = ticks - (ticks % 3000000000n);
  const hash = crypto.createHash("sha256");
  hash.update(String(roundedTicks) + TRUSTED_CLIENT_TOKEN, "ascii");
  return hash.digest("hex").toUpperCase();
}

function readStdin() {
  return new Promise(function (resolve, reject) {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", function (c) { data += c; });
    process.stdin.on("end", function () { resolve(data); });
    process.stdin.on("error", reject);
  });
}

function xmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** The SSML document for one synthesis request (exported for tests). */
function buildSsml(voice, text, lang, rate, pitch, volume) {
  return "<speak version=\"1.0\" xmlns=\"http://www.w3.org/2001/10/synthesis\" xmlns:mstts=\"https://www.w3.org/2001/mstts\" xml:lang=\"" + lang + "\">"
    + "<voice name=\"" + xmlEscape(voice) + "\">"
    + "<prosody rate=\"" + xmlEscape(rate) + "\" pitch=\"" + xmlEscape(pitch) + "\" volume=\"" + xmlEscape(volume) + "\">"
    + xmlEscape(text)
    + "</prosody></voice></speak>";
}

function fail(msg) {
  console.error("ERR " + msg);
  process.exit(1);
}

function synthesizeOnce(voice, text, outPath, lang, rate, pitch, volume) {
  return new Promise(function (resolve, reject) {
    const secMsGec = generateSecMsGecToken();
    const url = WSS_BASE + "?TrustedClientToken=" + TRUSTED_CLIENT_TOKEN + "&Sec-MS-GEC=" + secMsGec + "&Sec-MS-GEC-Version=1-" + CHROMIUM_FULL_VERSION;
    const ws = new WebSocket(url, {
      headers: {
        "Pragma": "no-cache",
        "Cache-Control": "no-cache",
        "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    ws.binaryType = "arraybuffer";
    const chunks = [];
    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      const buf = Buffer.concat(chunks);
      if (buf.length < 100) {
        try { ws.close(); } catch (e) {}
        reject("audio too small: " + buf.length);
        return;
      }
      try {
        fs.writeFileSync(outPath, buf);
        try { ws.close(); } catch (e) {}
        resolve(buf.length);
      } catch (e) {
        reject("write " + e.message);
      }
    }
    ws.onerror = function (e) {
      reject("websocket error: " + (e && e.message ? e.message : String(e)));
    };
    ws.onclose = function (e) {
      if (!settled) reject("closed early code=" + e.code + " reason=" + e.reason);
    };
    ws.onmessage = function (event) {
      if (settled) return;
      if (typeof event.data === "string") {
        if (event.data.indexOf("Path:turn.end") >= 0) { finish(); return; }
        return;
      }
      const raw = Buffer.from(event.data);
      const marker = Buffer.from("Path:audio" + CRLF);
      const idx = raw.indexOf(marker);
      if (idx >= 0) {
        const body = raw.subarray(idx + marker.length);
        if (body.length > 0) chunks.push(body);
      } else if (raw.length > 0) {
        chunks.push(raw);
      }
    };
    ws.onopen = function () {
      const requestId = crypto.randomBytes(16).toString("hex");
      const speechConfig = { context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "true" }, outputFormat: "audio-24khz-48kbitrate-mono-mp3" } } } };
      const ssml = buildSsml(voice, text, lang, rate, pitch, volume);
      ws.send("Content-Type:application/json; charset=utf-8" + CRLF + "Path:speech.config" + CRLF + CRLF + JSON.stringify(speechConfig));
      ws.send("X-RequestId:" + requestId + CRLF + "Content-Type:application/ssml+xml" + CRLF + "Path:ssml" + CRLF + CRLF + ssml);
    };
    setTimeout(function () {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch (e) {}
        reject("timeout");
      }
    }, 60000);
  });
}

async function main() {
  // Spawned as `node tts-worker.cjs <voice> <rate> <pitch> <volume>`; the text arrives on stdin.
  const voice = process.argv[2] || "zh-CN-XiaoxuanNeural";
  const rate = process.argv[3] || "default";
  const pitch = process.argv[4] || "default";
  const volume = process.argv[5] || "default";
  const text = (await readStdin()).trim();
  if (!text) return fail("empty text");
  const vparts = String(voice).split("-");
  const lang = (vparts.length >= 2 ? vparts[0] + "-" + vparts[1] : "zh-CN");
  const outPath = path.join(os.tmpdir(), "dsh-tts-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".mp3");
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const size = await synthesizeOnce(voice, text, outPath, lang, rate, pitch, volume);
      console.log("OK " + outPath);
      console.log("SIZE " + size);
      process.exit(0);
    } catch (e) {
      lastErr = e;
      const msg = String(e);
      if (msg.indexOf("1006") < 0) break;
    }
  }
  return fail(String(lastErr));
}

module.exports = { generateSecMsGecToken, xmlEscape, buildSsml };

if (require.main === module) {
  main().catch(function (e) {
    console.error("ERR fatal: " + (e && e.stack ? e.stack : String(e)));
    process.exit(1);
  });
}
