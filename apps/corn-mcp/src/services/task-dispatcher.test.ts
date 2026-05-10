// Task Dispatcher (S5.2) tests. The dispatcher itself is HTTP-only (no
// DB), so these are pure unit tests that mock fetch via the
// `_setFetchImplForTests` injection seam. Each test wires its own
// fixtures + restores the global registry/cache in afterEach.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  registerTask,
  runTask,
  fetchTaskEngineConfig,
  chatCompleteRemote,
  RemoteChatError,
  TaskDisabledError,
  _resetTaskRegistryForTests,
  _resetTaskConfigCacheForTests,
  _setFetchImplForTests,
  _resetFetchImplForTests,
  type TaskEngineConfig,
  type RemoteChatResponse,
} from './task-dispatcher.js'
import type { McpEnv } from '@corn/shared-types'

// ── Test fixtures ───────────────────────────────────────

const TEST_ENV: McpEnv = {
  QDRANT_URL: '',
  DASHBOARD_API_URL: 'http://test-api:4000',
  DASHBOARD_API_KEY: 'test-key',
  MCP_SERVER_NAME: 'test',
  MCP_SERVER_VERSION: '0.0.0',
  API_KEYS: '',
}

function configFixture(overrides: Partial<TaskEngineConfig> = {}): TaskEngineConfig {
  return {
    task_name: 'test_task',
    engine: 'heuristic',
    provider_id: null,
    model: 'gpt-4o-mini',
    enabled: 1,
    fallback_to_heuristic: 1,
    prompt_template: null,
    timeout_ms: 30_000,
    max_input_tokens: 8000,
    max_output_tokens: 1024,
    temperature: 0.2,
    cache_ttl_sec: 3600,
    cost_cap_usd_per_day: 0,
    description: null,
    ...overrides,
  }
}

function chatResponseFixture(overrides: Partial<RemoteChatResponse> = {}): RemoteChatResponse {
  return {
    content: '{"result": 42}',
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.000123,
    latencyMs: 150,
    cached: false,
    providerId: 'env:openai',
    provider: 'openai',
    model: 'gpt-4o-mini',
    tokensEstimated: false,
    ...overrides,
  }
}

/** Build a fetch mock that maps URL → JSON response, keyed by substring match. */
function makeFetch(routes: { match: string; status?: number; body: unknown }[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    // `input` is `string | URL | Request` per the WHATWG fetch signature.
    // We deliberately avoid relying on the DOM `RequestInfo` global since
    // the corn-mcp package targets `lib: ['ES2022']` only.
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : (input as Request).url
    const route = routes.find((r) => url.includes(r.match))
    if (!route) {
      throw new Error(`mock fetch: no route for ${url}`)
    }
    const status = route.status ?? 200
    return new Response(JSON.stringify(route.body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
}

beforeEach(() => {
  _resetTaskRegistryForTests()
  _resetTaskConfigCacheForTests()
})

afterEach(() => {
  _resetFetchImplForTests()
})

// ── 1. registerTask + runTask: heuristic engine ─────────
test('runTask runs heuristic when config.engine=heuristic', async () => {
  registerTask<{ x: number }, number>('test_task', {
    heuristic: ({ x }) => x * 2,
  })

  _setFetchImplForTests(makeFetch([
    { match: '/api/system/task-engines/test_task', body: { config: configFixture() } },
  ]))

  const { result, metadata } = await runTask<{ x: number }, number>(
    'test_task',
    { x: 7 },
    TEST_ENV,
  )
  assert.equal(result, 14)
  assert.equal(metadata.engineUsed, 'heuristic')
  assert.equal(metadata.fellBack, false)
})

// ── 2. runTask runs llm when config.engine=llm ──────────
test('runTask runs llm handler when config.engine=llm', async () => {
  registerTask<{ x: number }, string>('test_task', {
    heuristic: () => 'heuristic-result',
    llm: async (_, ctx) => {
      const resp = await chatCompleteRemote(
        { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
        ctx.env,
      )
      return `llm:${resp.content}`
    },
  })

  _setFetchImplForTests(makeFetch([
    { match: '/api/system/task-engines/test_task', body: { config: configFixture({ engine: 'llm' }) } },
    { match: '/api/llm/chat-complete', body: chatResponseFixture({ content: 'hello' }) },
  ]))

  const { result, metadata } = await runTask<{ x: number }, string>(
    'test_task',
    { x: 1 },
    TEST_ENV,
  )
  assert.equal(result, 'llm:hello')
  assert.equal(metadata.engineUsed, 'llm')
  assert.equal(metadata.fellBack, false)
})

// ── 3. LLM error → fallback to heuristic when allowed ──
test('runTask falls back to heuristic on llm error when fallback=1', async () => {
  registerTask<{ x: number }, string>('test_task', {
    heuristic: ({ x }) => `heuristic:${x}`,
    llm: async () => {
      throw new Error('provider exploded')
    },
  })

  _setFetchImplForTests(makeFetch([
    { match: '/api/system/task-engines/test_task', body: { config: configFixture({ engine: 'llm' }) } },
  ]))

  const { result, metadata } = await runTask<{ x: number }, string>(
    'test_task',
    { x: 9 },
    TEST_ENV,
  )
  assert.equal(result, 'heuristic:9')
  assert.equal(metadata.engineUsed, 'heuristic')
  assert.equal(metadata.fellBack, true)
  assert.match(metadata.llmError ?? '', /provider exploded/)
})

// ── 4. LLM error rethrows when fallback=0 ──────────────
test('runTask rethrows on llm error when fallback_to_heuristic=0', async () => {
  registerTask<{ x: number }, string>('test_task', {
    heuristic: () => 'unreachable',
    llm: async () => {
      throw new Error('provider exploded')
    },
  })

  _setFetchImplForTests(makeFetch([
    {
      match: '/api/system/task-engines/test_task',
      body: { config: configFixture({ engine: 'llm', fallback_to_heuristic: 0 }) },
    },
  ]))

  await assert.rejects(
    () => runTask('test_task', { x: 1 }, TEST_ENV),
    /provider exploded/,
  )
})

// ── 5. Disabled task throws TaskDisabledError ──────────
test('runTask throws TaskDisabledError when config.enabled=0', async () => {
  registerTask<unknown, string>('test_task', {
    heuristic: () => 'never',
  })

  _setFetchImplForTests(makeFetch([
    { match: '/api/system/task-engines/test_task', body: { config: configFixture({ enabled: 0 }) } },
  ]))

  await assert.rejects(
    () => runTask('test_task', {}, TEST_ENV),
    (err: unknown) =>
      err instanceof TaskDisabledError && (err as TaskDisabledError).taskName === 'test_task',
  )
})

// ── 6. LLM-config but no llm handler → heuristic path ──
test('runTask uses heuristic when engine=llm but task has no llm handler', async () => {
  registerTask<{ x: number }, string>('test_task', {
    heuristic: () => 'heuristic-only',
  })

  _setFetchImplForTests(makeFetch([
    { match: '/api/system/task-engines/test_task', body: { config: configFixture({ engine: 'llm' }) } },
  ]))

  const { result, metadata } = await runTask<{ x: number }, string>(
    'test_task',
    { x: 1 },
    TEST_ENV,
  )
  assert.equal(result, 'heuristic-only')
  assert.equal(metadata.engineUsed, 'heuristic')
  assert.equal(metadata.fellBack, false)
})

// ── 7. Unknown task throws programmer error ────────────
test('runTask throws when task is not registered', async () => {
  _setFetchImplForTests(makeFetch([
    { match: '/api/system/task-engines/missing', body: { config: configFixture({ task_name: 'missing' }) } },
  ]))
  await assert.rejects(
    () => runTask('missing', {}, TEST_ENV),
    /not registered with the dispatcher/,
  )
})

// ── 8. fetchTaskEngineConfig stays online when corn-api is down ─
test('fetchTaskEngineConfig returns synth heuristic when API is unreachable', async () => {
  _setFetchImplForTests(async () => {
    throw new Error('ECONNREFUSED')
  })

  const cfg = await fetchTaskEngineConfig('plan_quality', TEST_ENV)
  assert.equal(cfg.engine, 'heuristic')
  assert.equal(cfg.enabled, 1)
  assert.equal(cfg.task_name, 'plan_quality')
})

// ── 9. fetchTaskEngineConfig caches per-task within TTL ─
test('fetchTaskEngineConfig caches result and avoids second HTTP call', async () => {
  let callCount = 0
  _setFetchImplForTests((async (input: Parameters<typeof fetch>[0]) => {
    callCount++
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : (input as Request).url
    if (url.includes('/api/system/task-engines/cached_task')) {
      return new Response(JSON.stringify({ config: configFixture({ task_name: 'cached_task' }) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`unexpected url: ${url}`)
  }) as typeof fetch)

  await fetchTaskEngineConfig('cached_task', TEST_ENV)
  await fetchTaskEngineConfig('cached_task', TEST_ENV)
  await fetchTaskEngineConfig('cached_task', TEST_ENV)
  assert.equal(callCount, 1)
})

// ── 10. chatCompleteRemote maps cost_cap_exceeded HTTP 402 ──
test('chatCompleteRemote throws RemoteChatError with code=cost_cap_exceeded', async () => {
  _setFetchImplForTests(async () =>
    new Response(
      JSON.stringify({ error: 'cap reached', code: 'cost_cap_exceeded', detail: 1.23 }),
      { status: 402, headers: { 'Content-Type': 'application/json' } },
    ),
  )

  try {
    await chatCompleteRemote(
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      TEST_ENV,
    )
    assert.fail('Expected RemoteChatError to be thrown')
  } catch (err) {
    assert.ok(err instanceof RemoteChatError, 'expected RemoteChatError')
    const e = err as RemoteChatError
    assert.equal(e.code, 'cost_cap_exceeded')
    assert.equal(e.status, 402)
    assert.equal(e.isCostCap, true)
    assert.equal(e.isProviderFailure, false)
  }
})

// ── 11. chatCompleteRemote happy path returns response ──
test('chatCompleteRemote returns body on 200', async () => {
  _setFetchImplForTests(async () =>
    new Response(JSON.stringify(chatResponseFixture({ content: 'ok' })), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )

  const resp = await chatCompleteRemote(
    { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    TEST_ENV,
  )
  assert.equal(resp.content, 'ok')
  assert.equal(resp.inputTokens, 10)
  assert.equal(resp.providerId, 'env:openai')
})

// ── 12. opts.config bypasses HTTP fetch for tests ──────
test('runTask honors opts.config and skips HTTP fetch', async () => {
  registerTask<{ x: number }, number>('test_task', {
    heuristic: ({ x }) => x + 1,
  })

  let calls = 0
  _setFetchImplForTests(async () => {
    calls++
    throw new Error('should not be called')
  })

  const { result } = await runTask<{ x: number }, number>(
    'test_task',
    { x: 41 },
    TEST_ENV,
    { config: configFixture({ task_name: 'test_task' }) },
  )
  assert.equal(result, 42)
  assert.equal(calls, 0)
})
