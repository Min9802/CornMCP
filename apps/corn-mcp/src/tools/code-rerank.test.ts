import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  runHeuristic,
  parseLlmJson,
  registerCodeRerankTask,
  CODE_RERANK_TASK_NAME,
  DEFAULT_TOP_K,
  type CodeRerankInput,
  type CodeRerankItem,
  type CodeRerankResult,
} from './code-rerank.js'
import {
  _resetFetchImplForTests,
  _resetTaskConfigCacheForTests,
  _resetTaskRegistryForTests,
  _setFetchImplForTests,
  runTask,
  type TaskEngineConfig,
} from '../services/task-dispatcher.js'
import type { McpEnv } from '@corn/shared-types'

const env: McpEnv = {
  QDRANT_URL: '',
  DASHBOARD_API_URL: 'http://test.local',
  DASHBOARD_API_KEY: 'test-key',
  MCP_SERVER_NAME: 'corn-mcp-test',
  MCP_SERVER_VERSION: '0.0.0',
  API_KEYS: '',
}

function makeConfig(overrides: Partial<TaskEngineConfig> = {}): TaskEngineConfig {
  return {
    task_name: CODE_RERANK_TASK_NAME,
    engine: 'llm',
    provider_id: 'test-provider',
    model: 'gpt-4o-mini',
    enabled: 1,
    fallback_to_heuristic: 1,
    prompt_template: null,
    timeout_ms: 30_000,
    max_input_tokens: 8000,
    max_output_tokens: 512,
    temperature: 0.1,
    cache_ttl_sec: 3600,
    cost_cap_usd_per_day: 0,
    description: null,
    ...overrides,
  }
}

function makeChatResponse(content: string) {
  return new Response(
    JSON.stringify({
      content,
      inputTokens: 80,
      outputTokens: 60,
      costUsd: 0.0002,
      latencyMs: 120,
      cached: false,
      providerId: 'test-provider',
      provider: 'openai',
      model: 'gpt-4o-mini',
      tokensEstimated: false,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('code-rerank — heuristic', () => {
  test('empty items → empty result', () => {
    assert.deepEqual(runHeuristic({ query: 'x', items: [] }), { items: [] })
  })

  test('sorts by score desc, preserves tie order', () => {
    const res = runHeuristic({
      query: 'auth',
      items: [
        { id: 'a', snippet: 'x', score: 0.5 },
        { id: 'b', snippet: 'y', score: 0.9 },
        { id: 'c', snippet: 'z', score: 0.5 },
      ],
    })
    assert.deepEqual(res.items.map((i) => i.id), ['b', 'a', 'c'])
  })

  test('items without score drop to end', () => {
    const res = runHeuristic({
      query: 'x',
      items: [
        { id: 'a', snippet: 'x' },
        { id: 'b', snippet: 'y', score: 0.7 },
      ],
    })
    assert.deepEqual(res.items.map((i) => i.id), ['b', 'a'])
  })

  test('drops items with missing id', () => {
    const res = runHeuristic({
      query: 'x',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      items: [{ id: '', snippet: 'x', score: 0.9 } as any, { id: 'b', snippet: 'y', score: 0.3 }],
    })
    assert.deepEqual(res.items.map((i) => i.id), ['b'])
  })

  test('DEFAULT_TOP_K is 10', () => {
    assert.equal(DEFAULT_TOP_K, 10)
  })
})

describe('code-rerank — parseLlmJson', () => {
  const original: CodeRerankItem[] = [
    { id: 'a', snippet: 'x', score: 0.4 },
    { id: 'b', snippet: 'y', score: 0.6 },
  ]

  test('happy path parses items + sorts by score desc', () => {
    const res = parseLlmJson(
      '{"items":[{"id":"a","score":0.2,"reason":"off"},{"id":"b","score":0.8,"reason":"match"}]}',
      original,
    )
    assert.deepEqual(res.map((r) => r.id), ['b', 'a'])
    assert.equal(res[0]!.reason, 'match')
  })

  test('code-fenced json is unwrapped', () => {
    const res = parseLlmJson(
      '```json\n{"items":[{"id":"a","score":0.9},{"id":"b","score":0.1}]}\n```',
      original,
    )
    assert.deepEqual(res.map((r) => r.id), ['a', 'b'])
  })

  test('hallucinated id is dropped', () => {
    const res = parseLlmJson(
      '{"items":[{"id":"ghost","score":0.99},{"id":"b","score":0.5}]}',
      original,
    )
    // Only `b` kept from LLM output; `a` appended with upstream score 0.4.
    assert.deepEqual(res.map((r) => r.id), ['b', 'a'])
    assert.equal(res[1]!.score, 0.4)
  })

  test('omitted items fall back to upstream score', () => {
    const res = parseLlmJson('{"items":[{"id":"a","score":0.7}]}', original)
    assert.deepEqual(res.map((r) => r.id), ['a', 'b'])
    assert.equal(res[1]!.score, 0.6) // original score preserved
  })

  test('clamps score to [0, 1]', () => {
    const res = parseLlmJson(
      '{"items":[{"id":"a","score":5},{"id":"b","score":-0.5}]}',
      original,
    )
    const byId = new Map(res.map((r) => [r.id, r.score]))
    assert.equal(byId.get('a'), 1)
    assert.equal(byId.get('b'), 0)
  })

  test('string score is coerced', () => {
    const res = parseLlmJson('{"items":[{"id":"a","score":"0.73"}]}', original)
    assert.ok(res[0]!.score > 0.7 && res[0]!.score < 0.74)
  })

  test('invalid root JSON throws', () => {
    assert.throws(() => parseLlmJson('not json', original), /not valid JSON/)
  })

  test('missing items array throws', () => {
    assert.throws(() => parseLlmJson('{"foo":true}', original), /invalid `items` array/)
  })
})

describe('code-rerank — dispatcher integration', () => {
  beforeEach(() => {
    _resetFetchImplForTests()
    _resetTaskConfigCacheForTests()
    _resetTaskRegistryForTests()
    registerCodeRerankTask()
  })

  afterEach(() => {
    _resetFetchImplForTests()
    _resetTaskConfigCacheForTests()
    _resetTaskRegistryForTests()
  })

  test('llm happy path reranks via JSON', async () => {
    _setFetchImplForTests(async () =>
      makeChatResponse('{"items":[{"id":"a","score":0.2},{"id":"b","score":0.9}]}'),
    )

    const { result, metadata } = await runTask<CodeRerankInput, CodeRerankResult>(
      CODE_RERANK_TASK_NAME,
      {
        query: 'handle auth',
        items: [
          { id: 'a', snippet: 'some unrelated code', score: 0.5 },
          { id: 'b', snippet: 'function login(...) {}', score: 0.5 },
        ],
      },
      env,
      { config: makeConfig() },
    )
    assert.deepEqual(result.items.map((i) => i.id), ['b', 'a'])
    assert.equal(metadata.engineUsed, 'llm')
    assert.equal(metadata.fellBack, false)
  })

  test('llm invalid JSON → fallback to heuristic', async () => {
    _setFetchImplForTests(async () => makeChatResponse('not-json'))
    const { result, metadata } = await runTask<CodeRerankInput, CodeRerankResult>(
      CODE_RERANK_TASK_NAME,
      {
        query: 'x',
        items: [
          { id: 'a', snippet: 'x', score: 0.9 },
          { id: 'b', snippet: 'y', score: 0.1 },
        ],
      },
      env,
      { config: makeConfig() },
    )
    assert.deepEqual(result.items.map((i) => i.id), ['a', 'b'])
    assert.equal(metadata.engineUsed, 'heuristic')
    assert.equal(metadata.fellBack, true)
  })

  test('empty items short-circuits without fetch', async () => {
    let calls = 0
    _setFetchImplForTests(async () => {
      calls++
      return makeChatResponse('{"items":[]}')
    })
    const { result } = await runTask<CodeRerankInput, CodeRerankResult>(
      CODE_RERANK_TASK_NAME,
      { query: 'x', items: [] },
      env,
      { config: makeConfig() },
    )
    assert.equal(calls, 0)
    assert.deepEqual(result.items, [])
  })

  test('topK caps llm rerank; tail kept verbatim', async () => {
    _setFetchImplForTests(async () =>
      makeChatResponse('{"items":[{"id":"a","score":0.9},{"id":"b","score":0.1}]}'),
    )
    const { result } = await runTask<CodeRerankInput, CodeRerankResult>(
      CODE_RERANK_TASK_NAME,
      {
        query: 'x',
        topK: 2,
        items: [
          { id: 'a', snippet: 'a', score: 0.5 },
          { id: 'b', snippet: 'b', score: 0.5 },
          { id: 'c', snippet: 'c', score: 0.4 },
        ],
      },
      env,
      { config: makeConfig() },
    )
    assert.deepEqual(result.items.map((i) => i.id), ['a', 'b', 'c'])
  })

  test('registerCodeRerankTask is idempotent', () => {
    registerCodeRerankTask()
    registerCodeRerankTask()
  })
})
