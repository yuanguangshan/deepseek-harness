// Verification: drive pi-ai's openai-completions stream against muse-spark-1.2
// and report whether it terminates cleanly (done/stop) instead of erroring
// with "Stream ended without finish_reason" (TRANSPORT).
// After the patch at dist/api/openai-completions.js:437, a stream that lacks a
// finish_reason but collected content must be treated as a normal stop.
import { createProvider } from '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/models.js'
import { openAICompletionsApi } from '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js'
import { readFileSync } from 'node:fs'

// 密钥不再硬编码（历史版本曾泄露至公开 fork，已作废）。
// 读取顺序：环境变量 MUSE_API_KEY → 同目录 .env.muse（已 gitignore，权限 600）。
function loadLocalKey() {
  try {
    const line = readFileSync(new URL('./.env.muse', import.meta.url), 'utf8')
      .split('\n').find((l) => l.startsWith('MUSE_API_KEY='))
    return line ? line.slice('MUSE_API_KEY='.length).trim() : undefined
  } catch {
    return undefined
  }
}

const API_KEY = process.env.MUSE_API_KEY ?? loadLocalKey()
if (!API_KEY) {
  console.error('缺少 API key：请设置环境变量 MUSE_API_KEY，或在脚本同目录创建 .env.muse（内容形如 MUSE_API_KEY=sk-...）')
  process.exit(1)
}
const BASE = 'https://opencode.ai/zen/go/v1'
const MODEL_ID = process.argv[2] ?? 'muse-spark-1.2'

const provider = createProvider({
  id: 'meta',
  name: 'meta',
  baseUrl: BASE,
  api: openAICompletionsApi(),
  models: [
    {
      id: MODEL_ID,
      name: 'Muse Spark 1.2',
      api: 'openai-completions',
      baseUrl: BASE,
      input: ['text'],
      contextWindow: 1000000,
      maxTokens: 384000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ],
})

const model = provider.getModels()[0]
const context = {
  systemPrompt: 'You are a coding agent.',
  messages: [{ role: 'user', content: 'Reply with exactly the word OK.', timestamp: 0 }],
}

const events = provider.streamSimple(model, context, { apiKey: API_KEY, timeoutMs: 60000 })

let sawDone = false
let sawError = false
let gotText = ''
let sawStop = false
let payload = null
for await (const ev of events) {
  if (ev.type === 'text_delta') gotText += ev.delta
  if (ev.type === 'done') {
    sawDone = true
    payload = ev.message
    sawStop = ev.reason === 'stop'
  }
  if (ev.type === 'error') {
    sawError = true
    console.error('[verify] ERROR event:', JSON.stringify(ev, null, 2))
  }
  if (ev.type === 'text_end') {
    // terminal block
  }
}

console.log('[verify] model      :', MODEL_ID)
console.log('[verify] gotText    :', JSON.stringify(gotText))
console.log('[verify] sawDone    :', sawDone)
console.log('[verify] sawStop    :', sawStop)
console.log('[verify] sawError   :', sawError)
if (payload) {
  console.log('[verify] stopReason :', payload.stopReason)
  console.log('[verify] blocks     :', payload.content?.length)
}

const ok = sawDone && sawStop && !sawError
console.log(`[verify] RESULT: ${ok ? 'PASS — clean stop (patch works)' : 'FAIL — stream did not terminate cleanly'}`)
process.exit(ok ? 0 : 1)
