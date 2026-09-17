/**
 * Sibling routes sharing one gateway: every route key resolves its own wire
 * protocol, endpoint, session header, and models, and only its own. The
 * fixture is inline because a deployment's settings document is machine state,
 * not repository content; `catalog.spec.ts` owns the surrounding catalog rules
 * that size and validate individual models.
 */
import { describe, expect, it } from 'vitest'
import { resolveProfiles, type PiAiProviderProfile } from '../src/config.ts'

/** Two routes on one gateway: one OpenAI-compatible, one Anthropic-messages. */
const PROVIDERS: Readonly<Record<string, PiAiProviderProfile>> = {
  'opencode-go': {
    api: 'openai-completions',
    baseURL: 'https://opencode.ai/zen/go/v1',
    sessionHeader: 'x-opencode-session',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_000_000, maxTokens: 384_000 },
      { id: 'omen-alpha', name: 'Omen Alpha', contextWindow: 500_000, maxTokens: 128_000 },
    ],
  },
  'opencode-go-union': {
    api: 'anthropic-messages',
    baseURL: 'https://opencode.ai/zen/go/v1',
    sessionHeader: 'x-opencode-session',
    models: [
      { id: 'union-alpha', name: 'Union Alpha Free', contextWindow: 500_000, maxTokens: 128_000 },
    ],
  },
}

describe('sibling routes on one gateway', () => {
  const routes = resolveProfiles(PROVIDERS, 'strict')

  it('resolves each route with its own wire protocol and session header', () => {
    const openaiCompatible = routes.get('opencode-go')
    const anthropic = routes.get('opencode-go-union')
    expect(openaiCompatible?.api).toBe('openai-completions')
    expect(anthropic?.api).toBe('anthropic-messages')
    for (const route of [openaiCompatible, anthropic]) {
      expect(route?.baseURL).toBe('https://opencode.ai/zen/go/v1')
      expect(route?.sessionHeader).toBe('x-opencode-session')
    }
  })

  it('keeps every model on the route that declared it', () => {
    // A sibling route must not inherit or absorb another route's models; this
    // split is what lets two profiles share one baseURL without collision.
    expect([...routes.get('opencode-go')!.configuredMaxTokens.keys()])
      .toEqual(['deepseek-v4-flash', 'omen-alpha'])
    expect([...routes.get('opencode-go-union')!.configuredMaxTokens.keys()]).toEqual(['union-alpha'])
  })

  it('sizes every configured model with a positive output cap and no catalog error', () => {
    for (const [name, route] of routes) {
      expect(route.modelErrors.size, `${name} modelErrors`).toBe(0)
      for (const [id, maxTokens] of route.configuredMaxTokens) {
        expect(Number.isSafeInteger(maxTokens) && maxTokens > 0, `${name}/${id} maxTokens`).toBe(true)
      }
    }
  })
})
