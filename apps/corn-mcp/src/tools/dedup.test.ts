import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  runHeuristic,
  parseLlmJson,
  runLlm,
  registerDedupTasks,
  MEMORY_DEDUP_TASK_NAME,
  KNOWLEDGE_DEDUP_TASK_NAME,
  DEFAULT_DEDUP_THRESHOLD,
  type DedupInput,
} from './dedup.js'
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
    task_name: MEMORY_DEDUP_TASK_NAME,
    engine: 'llm',
    provider_id: 'test-provider',
    model: 'gpt-4o-mini',
    enabled: 1,
    fallback_to_heuristic: 1,
    prompt_template: null,
    timeout_ms: 30_000,
    max_input_tokens: 8000,
    max_output_tokens: 256,
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
      inputTokens: 40,
      outputTokens: 25,
      costUsd: 0.0001,
      latencyMs: 100,
      cached: false,
      providerId: 'test-provider',
      provider: 'openai',
      model: 'gpt-4o-mini',
      tokensEstimated: false,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('dedup — heuristic', () => {
  test('empty candidates → not duplicate', () => {
    const res = runHeuristic({ content: 'hello', candidates: [] })
    assert.equal(res.isDuplicate, false)
    assert.ok(res.reason?.includes('no candidates'))
  })

  test('top score above default threshold → duplicate', () => {
    const res = runHeuristic({
      content: 'the build is broken',
      candidates: [
        { id: 'mem-1', content: 'build broken', score: 0.95 },
        { id: 'mem-2', content: 'something else', score: 0.4 },
      ],
    })
    assert.equal(res.isDuplicate, true)
    assert.equal(res.duplicateOfId, 'mem-1')
    assert.ok(res.reason?.includes('0.950'))
  })

  test('top score below threshold → not duplicate', () => {
    const res = runHeuristic({
      content: 'different topic',
      candidates: [
        { id: 'mem-1', content: 'other', score: 0.5 },
      ],
    })
    assert.equal(res.isDuplicate, false)
    assert.equal(res.duplicateOfId, undefined)
  })

  test('custom threshold overrides default', () => {
    const res = runHeuristic({
      content: 'x',
      candidates: [{ id: 'm', content: 'y', score: 0.85 }],
      threshold: 0.8,
    })
    assert.equal(res.isDuplicate, true)
    assert.equal(res.duplicateOfId, 'm')
  })

  test('default threshold constant is 0.92', () => {
    assert.equal(DEFAULT_DEDUP_THRESHOLD, 0.92)
  })

  test('malformed candidate entries are silently skipped', () => {
    const res = runHeuristic({
      content: 'x',
      candidates: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'm1', content: 'y', score: 'bad' as any },
        { id: 'm2', content: 'z', score: 0.99 },
      ],
    })
    assert.equal(res.isDuplicate, true)
    assert.equal(res.duplicateOfId, 'm2')
  })
})

describe('dedup — parseLlmJson', () => {
  const input: DedupInput = {
    content: 'x',
    candidates: [{ id: 'mem-1', content: 'y', score: 0.9 }],
  }

  test('happy path parses duplicate flag + id', () => {
    const res = parseLlmJson(
      '{"isDuplicate":true,"duplicateOfId":"mem-1","reason":"same fact"}',
      input,
    )
    assert.equal(res.isDuplicate, true)
    assert.equal(res.duplicateOfId, 'mem-1')
    assert.equal(res.reason, 'same fact')
  })

  test('code-fenced json is unwrapped', () => {
    const res = parseLlmJson(
      '```json\n{"isDuplicate":false,"duplicateOfId":"","reason":"unique"}\n```',
      input,
    )
    assert.equal(res.isDuplicate, false)
    assert.equal(res.duplicateOfId, undefined)
  })

  test('hallucinated id is dropped when not in candidates', () => {
    const res = parseLlmJson(
      '{"isDuplicate":true,"duplicateOfId":"mem-ghost","reason":"..."}',
      input,
    )
    // Still marked duplicate but no id passed through.
    assert.equal(res.isDuplicate, true)
    assert.equal(res.duplicateOfId, undefined)
  })

  test('missing isDuplicate coerces to false', () => {
    const res = parseLlmJson('{}', input)
    assert.equal(res.isDuplicate, false)
  })

  test('invalid json throws', () => {
    assert.throws(() => parseLlmJson('not json at all', input), /not valid JSON/)
  })
})

describe('dedup — dispatcher integration', () => {
  beforeEach(() => {
    _resetFetchImplForTests()
    _resetTaskConfigCacheForTests()
    _resetTaskRegistryForTests()
    registerDedupTasks()
  })

  afterEach(() => {
    _resetFetchImplForTests()
    _resetTaskConfigCacheForTests()
    _resetTaskRegistryForTests()
  })

  test('llm happy → JSON parsed + returned', async () => {
    _setFetchImplForTests(async () =>
      makeChatResponse('{"isDuplicate":true,"duplicateOfId":"mem-1","reason":"paraphrase"}'),
    )

    const { result, metadata } = await runTask<DedupInput, { isDuplicate: boolean; duplicateOfId?: string }>(
      MEMORY_DEDUP_TASK_NAME,
      {
        content: 'tests failing on CI',
        candidates: [{ id: 'mem-1', content: 'build failing on CI', score: 0.88 }],
      },
      env,
      { config: makeConfig() },
    )
    assert.equal(result.isDuplicate, true)
    assert.equal(result.duplicateOfId, 'mem-1')
    assert.equal(metadata.engineUsed, 'llm')
    assert.equal(metadata.fellBack, false)
  })

  test('llm non-JSON → fallback to heuristic', async () => {
    _setFetchImplForTests(async () => makeChatResponse('Sorry, I can only help with...'))

    const { result, metadata } = await runTask<DedupInput, { isDuplicate: boolean }>(
      MEMORY_DEDUP_TASK_NAME,
      {
        content: 'x',
        candidates: [{ id: 'mem-1', content: 'y', score: 0.99 }],
      },
      env,
      { config: makeConfig() },
    )
    // Heuristic sees score 0.99 ≥ 0.92 → duplicate.
    assert.equal(result.isDuplicate, true)
    assert.equal(metadata.engineUsed, 'heuristic')
    assert.equal(metadata.fellBack, true)
  })

  test('heuristic engine bypasses LLM', async () => {
    let fetchCalled = false
    _setFetchImplForTests(async () => {
      fetchCalled = true
      return makeChatResponse('{"isDuplicate":true}')
    })

    const { result, metadata } = await runTask<DedupInput, { isDuplicate: boolean }>(
      MEMORY_DEDUP_TASK_NAME,
      { content: 'x', candidates: [{ id: 'a', content: 'b', score: 0.3 }] },
      env,
      { config: makeConfig({ engine: 'heuristic' }) },
    )
    assert.equal(fetchCalled, false)
    assert.equal(result.isDuplicate, false)
    assert.equal(metadata.engineUsed, 'heuristic')
  })

  test('knowledge_dedup task name is registered separately', async () => {
    const { result } = await runTask<DedupInput, { isDuplicate: boolean }>(
      KNOWLEDGE_DEDUP_TASK_NAME,
      { content: 'x', candidates: [{ id: 'k1', content: 'y', score: 0.99 }] },
      env,
      { config: makeConfig({ task_name: KNOWLEDGE_DEDUP_TASK_NAME, engine: 'heuristic' }) },
    )
    assert.equal(result.isDuplicate, true)
  })

  test('runLlm with no candidates short-circuits without fetch', async () => {
    let fetchCalled = false
    _setFetchImplForTests(async () => {
      fetchCalled = true
      return makeChatResponse('{}')
    })

    const { result } = await runTask<DedupInput, { isDuplicate: boolean }>(
      MEMORY_DEDUP_TASK_NAME,
      { content: 'only', candidates: [] },
      env,
      { config: makeConfig() },
    )
    assert.equal(fetchCalled, false)
    assert.equal(result.isDuplicate, false)
  })

  test('registerDedupTasks is idempotent', () => {
    registerDedupTasks()
    registerDedupTasks()
    // Should not throw — re-registration overwrites with identical refs.
  })
})
