import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  runHeuristic,
  parseLlmInt,
  registerTokenCountTask,
  TOKEN_COUNT_TASK_NAME,
  type TokenCountInput,
  type TokenCountResult,
} from './token-count.js'
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
    task_name: TOKEN_COUNT_TASK_NAME,
    engine: 'llm',
    provider_id: 'test-provider',
    model: 'gpt-4o-mini',
    enabled: 1,
    fallback_to_heuristic: 1,
    prompt_template: null,
    timeout_ms: 30_000,
    max_input_tokens: 8000,
    max_output_tokens: 64,
    temperature: 0,
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
      inputTokens: 60,
      outputTokens: 5,
      costUsd: 0.00005,
      latencyMs: 80,
      cached: false,
      providerId: 'test-provider',
      provider: 'openai',
      model: 'gpt-4o-mini',
      tokensEstimated: false,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('token-count — heuristic', () => {
  test('empty string → 0 tokens', () => {
    assert.deepEqual(runHeuristic({ text: '' }), { tokens: 0, method: 'heuristic', model: undefined })
  })

  test('pure ASCII uses chars/4', () => {
    const text = 'hello world, this is a test of the tokenizer.'
    const res = runHeuristic({ text })
    // len=45 → ceil(45/4) = 12
    assert.equal(res.tokens, 12)
    assert.equal(res.method, 'heuristic')
  })

  test('CJK characters use the 1.5× multiplier', () => {
    // 10 CJK chars → 10 / 1.5 ≈ 6.67 → ceil(6.67) = 7
    const text = '中文测试一二三四五六'
    const res = runHeuristic({ text })
    assert.equal(res.tokens, 7)
  })

  test('mixed ASCII + CJK adds both passes', () => {
    // 'hi ' = 3 ascii, '中文' = 2 cjk
    // ascii: 3/4 = 0.75, cjk: 2/1.5 ≈ 1.33 → ceil(2.08) = 3
    const res = runHeuristic({ text: 'hi 中文' })
    assert.equal(res.tokens, 3)
  })

  test('echoes model back', () => {
    const res = runHeuristic({ text: 'x', model: 'gpt-4o' })
    assert.equal(res.model, 'gpt-4o')
  })
})

describe('token-count — parseLlmInt', () => {
  test('pure integer', () => {
    assert.equal(parseLlmInt('42'), 42)
  })
  test('integer with surrounding text', () => {
    assert.equal(parseLlmInt('approximately 128 tokens'), 128)
  })
  test('decimal truncates via Math.round on digit run', () => {
    // Our regex only grabs the integer part — "128.7" → "128".
    assert.equal(parseLlmInt('128.7'), 128)
  })
  test('no digits throws', () => {
    assert.throws(() => parseLlmInt('sorry, I cannot'), /did not return a number/)
  })
  test('negative not matched as digits → returns positive part', () => {
    // "-42" — digits regex grabs "42". That's ok for our use case.
    assert.equal(parseLlmInt('-42'), 42)
  })
})

describe('token-count — dispatcher integration', () => {
  beforeEach(() => {
    _resetFetchImplForTests()
    _resetTaskConfigCacheForTests()
    _resetTaskRegistryForTests()
    registerTokenCountTask()
  })

  afterEach(() => {
    _resetFetchImplForTests()
    _resetTaskConfigCacheForTests()
    _resetTaskRegistryForTests()
  })

  test('llm happy returns int', async () => {
    _setFetchImplForTests(async () => makeChatResponse('256'))
    const { result, metadata } = await runTask<TokenCountInput, TokenCountResult>(
      TOKEN_COUNT_TASK_NAME,
      { text: 'some text', model: 'gpt-4o' },
      env,
      { config: makeConfig() },
    )
    assert.equal(result.tokens, 256)
    assert.equal(result.method, 'llm')
    assert.equal(metadata.engineUsed, 'llm')
  })

  test('llm non-digit reply → fallback to heuristic', async () => {
    _setFetchImplForTests(async () => makeChatResponse('sorry'))
    const { result, metadata } = await runTask<TokenCountInput, TokenCountResult>(
      TOKEN_COUNT_TASK_NAME,
      { text: 'hello world' },
      env,
      { config: makeConfig() },
    )
    // heuristic: 11/4 = 3
    assert.equal(result.tokens, 3)
    assert.equal(result.method, 'heuristic')
    assert.equal(metadata.fellBack, true)
  })

  test('empty input short-circuits without fetch (llm path)', async () => {
    let calls = 0
    _setFetchImplForTests(async () => {
      calls++
      return makeChatResponse('0')
    })
    const { result } = await runTask<TokenCountInput, TokenCountResult>(
      TOKEN_COUNT_TASK_NAME,
      { text: '' },
      env,
      { config: makeConfig() },
    )
    assert.equal(calls, 0)
    assert.equal(result.tokens, 0)
  })

  test('heuristic engine bypasses LLM', async () => {
    let calls = 0
    _setFetchImplForTests(async () => {
      calls++
      return makeChatResponse('99')
    })
    const { result } = await runTask<TokenCountInput, TokenCountResult>(
      TOKEN_COUNT_TASK_NAME,
      { text: 'hello world' },
      env,
      { config: makeConfig({ engine: 'heuristic' }) },
    )
    assert.equal(calls, 0)
    assert.equal(result.method, 'heuristic')
  })

  test('registerTokenCountTask is idempotent', () => {
    registerTokenCountTask()
    registerTokenCountTask()
  })
})
