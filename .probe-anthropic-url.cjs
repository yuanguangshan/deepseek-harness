// 探测：Anthropic SDK 在给定 baseURL 下实际请求的 URL 与发送的头部。
// 不发起真实网络请求：注入假 fetch 截获请求。
const Anthropic = require('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@anthropic-ai/sdk/index.js')

async function probe(label, baseURL) {
  let seen = null
  const fakeFetch = async (url, init) => {
    seen = { url: String(url), headers: init?.headers }
    return new Response(JSON.stringify({
      id: 'msg_probe', type: 'message', role: 'assistant', model: 'union-alpha',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = new Anthropic({
    apiKey: 'sk-probe',
    baseURL,
    fetch: fakeFetch,
    defaultHeaders: { 'x-opencode-session': 'deepseek-harness', 'anthropic-version': '2023-06-01' },
  })
  try {
    await client.messages.create({ model: 'union-alpha', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] })
  } catch (e) {
    console.log(`  [${label}] 调用异常: ${e.message}`)
  }
  console.log(`\n[${label}]`)
  console.log(`  baseURL 配置: ${baseURL}`)
  console.log(`  实际请求 URL: ${seen ? seen.url : '(未发出)'}`)
  if (seen) {
    const h = seen.headers
    const get = (n) => (typeof h?.get === 'function' ? h.get(n) : h?.[n])
    for (const n of ['x-api-key', 'authorization', 'anthropic-version', 'x-opencode-session']) {
      console.log(`  header ${n}: ${get(n) ?? '(无)'}`)
    }
  }
}

;(async () => {
  console.log('=== Anthropic SDK baseURL 拼接实测（配置里的 headers 作为 defaultHeaders）===')
  await probe('当前配置: .../zen/go/v1', 'https://opencode.ai/zen/go/v1')
  await probe('候选写法: .../zen/go', 'https://opencode.ai/zen/go')
})()
