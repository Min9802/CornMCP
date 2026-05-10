// LLM Gateway integration tests (S4.8). Backed by an in-memory MongoDB
// replica-set (mongodb-memory-server). Providers are exercised via a
// swappable `fetchImpl` so we can deterministically return shape-specific
// responses per test without hitting the network.
//
// Coverage summary (15+):
//  1.  OpenAI happy path + provider-reported tokens
//  2.  Anthropic happy path + system role promotion
//  3.  Gemini happy path + role mapping
//  4.  Cache hit on identical prompt (second call no fetch)
//  5.  Cache miss on different temperature
//  6.  Cost MAE ≤ ε for gpt-4o-mini with known token counts
//  7.  Pricing override via setting wins over defaults
//  8.  Cost cap triggers (pre-seeded logs push spent ≥ cap)
//  9.  Provider timeout → ProviderTimeoutError
// 10.  401 → ProviderAuthError
// 11.  429 with retry-after → ProviderRateLimitError
// 12.  Fallback chain: primary 500 → secondary returns content
// 13.  Virtual env provider resolves when DB empty + OPENAI_API_KEY set
// 14.  `llm.disable_env_fallback=true` blocks virtual chain
// 15.  Admin row for same provider type wins over virtual fallback
// 16.  query_logs row emitted after successful call
// 17.  Token estimation fallback when provider omits usage

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { MongoMemoryReplSet } from 'mongodb-memory-server'

// Env wiring BEFORE any DB/secrets/llm-gateway import.
process.env['SYSTEM_SETTINGS_MASTER_KEY'] = 'unit-test-master-key-do-not-use-in-prod'
delete process.env['AUTH_JWT_SECRET']
process.env['SYSTEM_SETTINGS_CACHE_TTL_MS'] = '50'
process.env['DATABASE_DRIVER'] = 'mongo'
// Clear any real provider env vars — tests set them explicitly per case.
delete process.env['OPENAI_API_KEY']
delete process.env['ANTHROPIC_API_KEY']
delete process.env['GEMINI_API_KEY']

const { setupTestMongo, teardownTestMongo } = await import('../../test-utils/mongo.js')
const { _resetKeyCacheForTests } = await import('../secrets.js')
const { _clearSettingsCacheForTests, setSetting } = await import('../settings.js')
const { _resetCacheForTests } = await import('./cache.js')
const { _resetCostCapCacheForTests } = await import('./cost.js')
const { _resetProviderLoaderForTests } = await import('./provider-loader.js')
const { LlmGatewayLog, ProviderAccount, QueryLog } = await import('../../db/mongoose/index.js')
const {
  chatComplete,
  CostCapExceededError,
  NoProviderConfiguredError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} = await import('./index.js')

_resetKeyCacheForTests()

let replSet: MongoMemoryReplSet

before(async () => {
  replSet = await setupTestMongo()
})

after(async () => {
  await teardownTestMongo(replSet)
})

// ── Test helpers ────────────────────────────────────────
interface FetchFixture {
  /** URL substring match. First match wins. */
  match: string
  status?: number
  headers?: Record<string, string>
  body?: unknown
  /** When set, the mock stalls and lets the caller's AbortSignal abort. */
  hang?: boolean
  /** Called with (url, init) so tests can assert request shape. */
  onCall?: (url: string, init: RequestInit | undefined) => void
}

/** Build a `fetch` implementation that matches URL → fixture. */
function makeFetch(fixtures: FetchFixture[]): {
  fetchImpl: typeof fetch
  calls: number
  callLog: Array<{ url: string; init: RequestInit | undefined }>
} {
  const state = { calls: 0, callLog: [] as Array<{ url: string; init: RequestInit | undefined }> }
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    state.calls += 1
    const url = typeof input === 'string' ? input : String(input)
    state.callLog.push({ url, init })
    const fixture = fixtures.find((f) => url.includes(f.match))
    if (!fixture) {
      throw new Error(`test: no fixture matched ${url}`)
    }
    fixture.onCall?.(url, init)

    if (fixture.hang) {
      return await new Promise<Response>((_, reject) => {
        const signal = init?.signal as AbortSignal | undefined
        if (!signal) return
        signal.addEventListener(
          'abort',
          () => {
            const err = new Error('aborted by timeout signal')
            err.name = 'TimeoutError'
            reject(err)
          },
          { once: true },
        )
      })
    }

    return new Response(JSON.stringify(fixture.body ?? {}), {
      status: fixture.status ?? 200,
      headers: { 'content-type': 'application/json', ...(fixture.headers ?? {}) },
    })
  }) as typeof fetch
  return { fetchImpl, ...state, get calls() { return state.calls } } as ReturnType<typeof makeFetch>
}

// Shared OpenAI response body builder
function openaiOk(content: string, inputTokens = 12, outputTokens = 8): unknown {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'gpt-4o-mini',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  }
}

function anthropicOk(content: string, inputTokens = 11, outputTokens = 9): unknown {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    model: 'claude-3-5-haiku-20241022',
    stop_reason: 'end_turn',
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  }
}

function geminiOk(content: string, inputTokens = 10, outputTokens = 7): unknown {
  return {
    candidates: [
      {
        content: { parts: [{ text: content }], role: 'model' },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: inputTokens,
      candidatesTokenCount: outputTokens,
      totalTokenCount: inputTokens + outputTokens,
    },
  }
}

/** Reset module-level state so tests don't leak into each other. */
function resetAll(): void {
  _clearSettingsCacheForTests()
  _resetCacheForTests()
  _resetCostCapCacheForTests()
  _resetProviderLoaderForTests()
}

async function seedSettings(kv: Record<string, string | null>, isSecretKeys: string[] = []): Promise<void> {
  const secrets = new Set(isSecretKeys)
  for (const [k, v] of Object.entries(kv)) {
    await setSetting(k, v, { isSecret: secrets.has(k), updatedBy: 'test' })
  }
  _clearSettingsCacheForTests()
}

// ── 1. OpenAI happy path ────────────────────────────────
test('OpenAI adapter — happy path with provider-reported tokens', async () => {
  resetAll()
  process.env['OPENAI_API_KEY'] = 'sk-test-openai-aaaa'
  const { fetchImpl } = makeFetch([
    { match: 'api.openai.com/v1/chat/completions', body: openaiOk('hello world', 20, 10) },
  ])

  const resp = await chatComplete(
    { provider: 'openai', model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    { fetchImpl },
  )
  assert.equal(resp.content, 'hello world')
  assert.equal(resp.provider, 'openai')
  assert.equal(resp.providerId, 'env:openai')
  assert.equal(resp.inputTokens, 20)
  assert.equal(resp.outputTokens, 10)
  assert.equal(resp.cached, false)
  assert.equal(resp.tokensEstimated, false)
  // Cost: gpt-4o-mini = 0.15 input + 0.6 output per 1M tokens
  // 20 * 0.15/1e6 + 10 * 0.6/1e6 = 3e-6 + 6e-6 = 9e-6 USD
  assert.ok(Math.abs(resp.costUsd - 9e-6) < 1e-9, `cost was ${resp.costUsd}`)

  delete process.env['OPENAI_API_KEY']
})

// ── 2. Anthropic happy path + system promotion ──────────
test('Anthropic adapter — promotes system role to top-level field', async () => {
  resetAll()
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-bbbb'
  let captured: unknown = null
  const { fetchImpl } = makeFetch([
    {
      match: 'api.anthropic.com/v1/messages',
      body: anthropicOk('anthropic-ok'),
      onCall: (_url, init) => { captured = JSON.parse(String(init?.body ?? '{}')) },
    },
  ])

  const resp = await chatComplete(
    {
      provider: 'anthropic',
      model: 'claude-3-5-haiku-20241022',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'ping' },
      ],
    },
    { fetchImpl },
  )
  assert.equal(resp.content, 'anthropic-ok')
  assert.equal(resp.providerId, 'env:anthropic')
  const body = captured as { system?: string; messages?: Array<{ role: string }> }
  assert.equal(body.system, 'be terse')
  assert.equal(body.messages?.length, 1, 'system should not leak into messages array')
  assert.equal(body.messages?.[0]?.role, 'user')

  delete process.env['ANTHROPIC_API_KEY']
})

// ── 3. Gemini happy path + role mapping ─────────────────
test('Gemini adapter — maps assistant→model and uses query-param auth', async () => {
  resetAll()
  process.env['GEMINI_API_KEY'] = 'AIza-test-cccc'
  let capturedUrl = ''
  let capturedBody: unknown = null
  const { fetchImpl } = makeFetch([
    {
      match: 'generativelanguage.googleapis.com',
      body: geminiOk('gemini-ok'),
      onCall: (url, init) => {
        capturedUrl = url
        capturedBody = JSON.parse(String(init?.body ?? '{}'))
      },
    },
  ])

  const resp = await chatComplete(
    {
      provider: 'gemini',
      model: 'gemini-1.5-flash',
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
      ],
    },
    { fetchImpl },
  )
  assert.equal(resp.content, 'gemini-ok')
  assert.ok(capturedUrl.includes('key=AIza-test-cccc'))
  assert.ok(capturedUrl.includes('gemini-1.5-flash:generateContent'))
  const body = capturedBody as { contents: Array<{ role: string }> }
  assert.equal(body.contents.length, 3)
  assert.equal(body.contents[1]!.role, 'model', 'assistant should map to model')

  delete process.env['GEMINI_API_KEY']
})

// ── 4. Cache hit on identical prompt ────────────────────
test('Cache — second identical call returns cached response without fetch', async () => {
  resetAll()
  process.env['OPENAI_API_KEY'] = 'sk-test-cache'
  const fx = makeFetch([
    { match: 'api.openai.com', body: openaiOk('cached-result') },
  ])

  const req = {
    provider: 'openai' as const,
    model: 'gpt-4o-mini',
    messages: [{ role: 'user' as const, content: 'same prompt' }],
    temperature: 0.0,
  }
  const first = await chatComplete(req, { fetchImpl: fx.fetchImpl })
  const second = await chatComplete(req, { fetchImpl: fx.fetchImpl })
  assert.equal(fx.calls, 1, 'second call should hit cache, not network')
  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  assert.equal(second.content, 'cached-result')
  assert.equal(second.costUsd, 0, 'cached response costs $0')

  delete process.env['OPENAI_API_KEY']
})

// ── 5. Cache miss on different temperature ──────────────
test('Cache — different temperature bypasses cache', async () => {
  resetAll()
  process.env['OPENAI_API_KEY'] = 'sk-test-cache-miss'
  const fx = makeFetch([
    { match: 'api.openai.com', body: openaiOk('v1') },
  ])

  const base = {
    provider: 'openai' as const,
    model: 'gpt-4o-mini',
    messages: [{ role: 'user' as const, content: 'same' }],
  }
  await chatComplete({ ...base, temperature: 0 }, { fetchImpl: fx.fetchImpl })
  await chatComplete({ ...base, temperature: 0.5 }, { fetchImpl: fx.fetchImpl })
  assert.equal(fx.calls, 2, 'different temperature should trigger a fresh fetch')

  delete process.env['OPENAI_API_KEY']
})

// ── 6. Cost accuracy — known inputs ─────────────────────
test('Cost — 1000 input + 500 output on gpt-4o-mini matches exact pricing', async () => {
  resetAll()
  process.env['OPENAI_API_KEY'] = 'sk-cost-test'
  const fx = makeFetch([
    { match: 'api.openai.com', body: openaiOk('x', 1000, 500) },
  ])
  const resp = await chatComplete(
    { provider: 'openai', model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'cost-me' }] },
    { fetchImpl: fx.fetchImpl },
  )
  // Pricing: input 0.15 / output 0.6 per 1M tokens
  // = 1000 * 0.15 / 1e6 + 500 * 0.6 / 1e6 = 0.00015 + 0.0003 = 0.00045 USD
  const expected = 0.00045
  assert.ok(
    Math.abs(resp.costUsd - expected) / expected < 0.01,
    `MAE exceeded 1%: got ${resp.costUsd}, expected ${expected}`,
  )

  delete process.env['OPENAI_API_KEY']
})

// ── 7. Pricing override ─────────────────────────────────
test('Cost — admin override via setting wins over DEFAULT_PRICING', async () => {
  resetAll()
  process.env['OPENAI_API_KEY'] = 'sk-override'
  await seedSettings({
    'llm.pricing.gpt-4o-mini': JSON.stringify({ input: 10, output: 20 }),
  })

  const fx = makeFetch([
    { match: 'api.openai.com', body: openaiOk('override', 1000, 1000) },
  ])
  const resp = await chatComplete(
    { provider: 'openai', model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] },
    { fetchImpl: fx.fetchImpl },
  )
  // With override: (1000 * 10 + 1000 * 20) / 1e6 = 0.03 USD
  assert.ok(Math.abs(resp.costUsd - 0.03) < 1e-6, `expected 0.03 got ${resp.costUsd}`)
  await setSetting('llm.pricing.gpt-4o-mini', null)

  delete process.env['OPENAI_API_KEY']
})

// ── 8. Cost cap triggers ────────────────────────────────
test('Cost cap — throws CostCapExceededError when daily spend ≥ cap', async () => {
  resetAll()
  process.env['OPENAI_API_KEY'] = 'sk-cap'
  // Seed an existing $2 spend today to blow through the $1 default cap.
  await LlmGatewayLog.create({
    task_name: 'seed',
    provider: 'openai',
    model: 'gpt-4o-mini',
    cost_usd: 2.0,
    error: null,
  } as Parameters<typeof LlmGatewayLog.create>[0])
  _resetCostCapCacheForTests()

  const fx = makeFetch([
    { match: 'api.openai.com', body: openaiOk('should-not-reach') },
  ])

  await assert.rejects(
    chatComplete(
      { provider: 'openai', model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] },
      { fetchImpl: fx.fetchImpl },
    ),
    (err: unknown) => err instanceof CostCapExceededError,
  )
  assert.equal(fx.calls, 0, 'cap must short-circuit before any fetch')

  // Clean up so later tests don't trip the cap.
  await LlmGatewayLog.deleteMany({ task_name: 'seed' })
  _resetCostCapCacheForTests()
  delete process.env['OPENAI_API_KEY']
})

// ── 9. Timeout ──────────────────────────────────────────
test('Provider timeout — AbortSignal fires and maps to ProviderTimeoutError', async () => {
  resetAll()
  process.env['OPENAI_API_KEY'] = 'sk-timeout'
  const fx = makeFetch([
    { match: 'api.openai.com', hang: true },
  ])
  await assert.rejects(
    chatComplete(
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'x' }],
        timeoutMs: 50,
      },
      { fetchImpl: fx.fetchImpl },
    ),
    (err: unknown) => err instanceof ProviderTimeoutError,
  )

  delete process.env['OPENAI_API_KEY']
})

// ── 10. 401 Auth error ──────────────────────────────────
test('Provider 401 → ProviderAuthError', async () => {
  resetAll()
  process.env['OPENAI_API_KEY'] = 'sk-bad'
  const fx = makeFetch([
    { match: 'api.openai.com', status: 401, body: { error: { message: 'invalid api key' } } },
  ])
  await assert.rejects(
    chatComplete(
      { provider: 'openai', model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] },
      { fetchImpl: fx.fetchImpl },
    ),
    (err: unknown) => err instanceof ProviderAuthError,
  )

  delete process.env['OPENAI_API_KEY']
})

// ── 11. 429 rate limit ──────────────────────────────────
test('Provider 429 → ProviderRateLimitError with retry-after', async () => {
  resetAll()
  process.env['OPENAI_API_KEY'] = 'sk-rate'
  const fx = makeFetch([
    {
      match: 'api.openai.com',
      status: 429,
      headers: { 'retry-after': '17' },
      body: { error: { message: 'too many' } },
    },
  ])
  await assert.rejects(
    chatComplete(
      { provider: 'openai', model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] },
      { fetchImpl: fx.fetchImpl },
    ),
    (err: unknown) => {
      if (!(err instanceof ProviderRateLimitError)) return false
      return err.retryAfterSec === 17
    },
  )

  delete process.env['OPENAI_API_KEY']
})

// ── 12. Fallback chain ──────────────────────────────────
test('Fallback chain — primary 500 falls through to secondary', async () => {
  resetAll()
  process.env['OPENAI_API_KEY'] = 'sk-fallback-primary'
  process.env['GEMINI_API_KEY'] = 'AIza-fallback-secondary'

  // Seed a real DB row for each so the chain can point by id.
  await ProviderAccount.create([
    {
      _id: 'prov-primary',
      name: 'P1',
      type: 'openai',
      api_base: 'https://api.openai.com/v1',
      api_key: 'sk-primary-direct',
      api_key_encrypted: false,
      status: 'enabled',
    },
    {
      _id: 'prov-secondary',
      name: 'P2',
      type: 'gemini',
      api_base: 'https://generativelanguage.googleapis.com/v1beta',
      api_key: 'gemini-direct',
      api_key_encrypted: false,
      status: 'enabled',
    },
  ] as unknown as Parameters<typeof ProviderAccount.create>[0])
  await seedSettings({
    'llm.fallback_chain': JSON.stringify(['prov-secondary']),
  })

  const fx = makeFetch([
    { match: 'api.openai.com', status: 500, body: { error: { message: 'boom' } } },
    { match: 'generativelanguage.googleapis.com', body: geminiOk('fallback-saved-us') },
  ])

  const resp = await chatComplete(
    {
      providerId: 'prov-primary',
      model: 'gemini-1.5-flash',
      messages: [{ role: 'user', content: 'x' }],
    },
    { fetchImpl: fx.fetchImpl },
  )
  assert.equal(resp.content, 'fallback-saved-us')
  assert.equal(resp.providerId, 'prov-secondary')
  assert.equal(fx.calls, 2)

  // Clean up.
  await ProviderAccount.deleteMany({ _id: { $in: ['prov-primary', 'prov-secondary'] } })
  await setSetting('llm.fallback_chain', null)
  delete process.env['OPENAI_API_KEY']
  delete process.env['GEMINI_API_KEY']
})

// ── 13. Virtual env provider ────────────────────────────
test('Virtual provider — resolves from OPENAI_API_KEY when DB empty', async () => {
  resetAll()
  process.env['OPENAI_API_KEY'] = 'sk-virtual-env'

  const fx = makeFetch([
    { match: 'api.openai.com', body: openaiOk('from-env') },
  ])
  const resp = await chatComplete(
    { provider: 'openai', model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] },
    { fetchImpl: fx.fetchImpl },
  )
  assert.equal(resp.providerId, 'env:openai')
  assert.equal(resp.content, 'from-env')

  delete process.env['OPENAI_API_KEY']
})

// ── 14. disable_env_fallback ────────────────────────────
test('llm.disable_env_fallback=true — blocks virtual chain even with env keys', async () => {
  resetAll()
  process.env['OPENAI_API_KEY'] = 'sk-should-be-ignored'
  await seedSettings({ 'llm.disable_env_fallback': 'true' })

  const fx = makeFetch([
    { match: 'api.openai.com', body: openaiOk('should-not-reach') },
  ])
  await assert.rejects(
    chatComplete(
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] },
      { fetchImpl: fx.fetchImpl },
    ),
    (err: unknown) => err instanceof NoProviderConfiguredError,
  )
  assert.equal(fx.calls, 0)

  await setSetting('llm.disable_env_fallback', null)
  delete process.env['OPENAI_API_KEY']
})

// ── 15. Admin row wins over virtual ─────────────────────
test('Admin row for same type — wins over virtual env fallback', async () => {
  resetAll()
  process.env['OPENAI_API_KEY'] = 'sk-env-shouldnt-win'
  await ProviderAccount.create({
    _id: 'prov-real-openai',
    name: 'RealO',
    type: 'openai',
    api_base: 'https://real.example.com/v1',
    api_key: 'sk-real-admin',
    api_key_encrypted: false,
    status: 'enabled',
  } as Parameters<typeof ProviderAccount.create>[0])

  let capturedUrl = ''
  const fx = makeFetch([
    {
      match: 'real.example.com',
      body: openaiOk('from-admin-row'),
      onCall: (url) => { capturedUrl = url },
    },
  ])
  const resp = await chatComplete(
    { provider: 'openai', model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] },
    { fetchImpl: fx.fetchImpl },
  )
  assert.equal(resp.providerId, 'prov-real-openai')
  assert.notEqual(resp.providerId, 'env:openai')
  assert.ok(capturedUrl.includes('real.example.com'), `hit ${capturedUrl}`)

  await ProviderAccount.deleteMany({ _id: 'prov-real-openai' })
  delete process.env['OPENAI_API_KEY']
})

// ── 16. query_logs mirrored ─────────────────────────────
test('query_logs — row written for successful call', async () => {
  resetAll()
  process.env['OPENAI_API_KEY'] = 'sk-querylog'
  const fx = makeFetch([
    { match: 'api.openai.com', body: openaiOk('logged-x', 7, 3) },
  ])

  const before = await QueryLog.countDocuments({ tool: 'llm_gateway' })
  await chatComplete(
    {
      provider: 'openai',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'log me' }],
      taskName: 'test_querylog',
    },
    { fetchImpl: fx.fetchImpl },
  )
  // Fire-and-forget write — give the event loop a tick.
  await new Promise((r) => setTimeout(r, 50))

  const after = await QueryLog.countDocuments({ tool: 'llm_gateway' })
  assert.equal(after, before + 1)

  const row = await QueryLog.findOne({ tool: 'llm_gateway' }).sort({ created_at: -1 }).lean()
  assert.equal(row?.tool, 'llm_gateway')
  assert.equal(row?.agent_id, 'test_querylog')
  assert.equal(Number(row?.compute_tokens), 10)
  assert.equal(row?.compute_model, 'gpt-4o-mini')

  delete process.env['OPENAI_API_KEY']
})

// ── 17. Token estimation when provider omits usage ──────
test('Token fallback — estimates when provider omits usage', async () => {
  resetAll()
  process.env['OPENAI_API_KEY'] = 'sk-noUsage'
  // Response without `usage` field → adapter returns null → gateway
  // estimates via char/4.
  const noUsageBody = {
    id: 'x', object: 'chat.completion', model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello there' }, finish_reason: 'stop' }],
  }
  const fx = makeFetch([
    { match: 'api.openai.com', body: noUsageBody },
  ])
  const resp = await chatComplete(
    { provider: 'openai', model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] },
    { fetchImpl: fx.fetchImpl },
  )
  assert.equal(resp.tokensEstimated, true)
  assert.ok(resp.inputTokens > 0)
  assert.ok(resp.outputTokens > 0)

  delete process.env['OPENAI_API_KEY']
})
