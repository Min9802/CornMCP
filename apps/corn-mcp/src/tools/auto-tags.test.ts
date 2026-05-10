// Auto-tags (S7.2) tests. Pure unit tests for `runHeuristic` +
// `validateAndDedupe`, plus dispatcher-integration tests for the LLM
// path that mock the chatCompleteRemote HTTP call via the
// `_setFetchImplForTests` injection seam from task-dispatcher.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { runHeuristic, runLlm, validateAndDedupe } from './auto-tags.js'
import {
  registerTask,
  runTask,
  _resetTaskRegistryForTests,
  _resetTaskConfigCacheForTests,
  _setFetchImplForTests,
  _resetFetchImplForTests,
  type TaskEngineConfig,
  type RemoteChatResponse,
} from '../services/task-dispatcher.js'
import type { McpEnv } from '@corn/shared-types'

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
    task_name: 'auto_tags_for_memory',
    engine: 'heuristic',
    provider_id: null,
    model: 'gpt-4o-mini',
    enabled: 1,
    fallback_to_heuristic: 1,
    prompt_template: null,
    timeout_ms: 30_000,
    max_input_tokens: 8000,
    max_output_tokens: 256,
    temperature: 0.2,
    cache_ttl_sec: 3600,
    cost_cap_usd_per_day: 0,
    description: null,
    ...overrides,
  }
}

function chatResponseFixture(overrides: Partial<RemoteChatResponse> = {}): RemoteChatResponse {
  return {
    content: '{"tags":["dispatcher","gateway","llm","phase","sprint"]}',
    inputTokens: 50,
    outputTokens: 20,
    costUsd: 0.0001,
    latencyMs: 150,
    cached: false,
    providerId: 'env:openai',
    provider: 'openai',
    model: 'gpt-4o-mini',
    tokensEstimated: false,
    ...overrides,
  }
}

beforeEach(() => {
  _resetTaskRegistryForTests()
  _resetTaskConfigCacheForTests()
})

afterEach(() => {
  _resetFetchImplForTests()
})

// ── 1. validateAndDedupe normalizes + filters ──────────
test('validateAndDedupe drops uppercase, symbols, length violations, dupes', () => {
  const input = [
    'GoodTag',          // uppercase → lowercased to "goodtag" → valid
    'two words',        // space → "two-words" → valid
    'short',            // 5 chars → valid
    'ab',               // < 3 chars → drop
    'ok!bad',           // "!" not allowed → drop
    'GoodTag',          // dupe of "goodtag" after lowercase → drop
    'a-very-long-tag-that-exceeds-the-thirty-char-cap', // > 30 → drop
    '',                 // empty → drop
    '_underscored_',    // strip surrounding underscores → "underscored" valid
  ]
  const out = validateAndDedupe(input)
  assert.deepEqual(out, ['goodtag', 'two-words', 'short', 'underscored'])
})

test('validateAndDedupe caps at 7 tags', () => {
  const input = ['tag1','tag2','tag3','tag4','tag5','tag6','tag7','tag8','tag9']
  const out = validateAndDedupe(input)
  assert.equal(out.length, 7)
  assert.deepEqual(out, ['tag1','tag2','tag3','tag4','tag5','tag6','tag7'])
})

// ── 2. runHeuristic happy path ──────────────────────────
test('runHeuristic extracts top frequency tokens', () => {
  const content = 'Phase S7 dispatcher LLM gateway. The dispatcher pipeline relays gateway calls. LLM cost cap.'
  const { tags } = runHeuristic({ content })
  // Most frequent: "dispatcher" (2), "gateway" (2), "llm" (2). Then alpha: "cap","cost","calls","phase","pipeline","relays","s7"
  assert.ok(tags.includes('dispatcher'), `expected "dispatcher" in ${JSON.stringify(tags)}`)
  assert.ok(tags.includes('gateway'), `expected "gateway" in ${JSON.stringify(tags)}`)
  assert.ok(tags.includes('llm'), `expected "llm" in ${JSON.stringify(tags)}`)
  assert.ok(tags.length <= 7)
  assert.ok(tags.length >= 3)
  // Stopwords excluded
  assert.ok(!tags.includes('the'))
})

test('runHeuristic returns empty for empty content', () => {
  assert.deepEqual(runHeuristic({ content: '' }).tags, [])
  assert.deepEqual(runHeuristic({ content: null as unknown as string }).tags, [])
  assert.deepEqual(runHeuristic({ content: '   \n\t  ' }).tags, [])
})

test('runHeuristic skips numeric-only tokens and stopwords', () => {
  const content = 'this is a 2024 phase but the gateway and dispatcher matter most'
  const { tags } = runHeuristic({ content })
  assert.ok(!tags.includes('2024'))
  assert.ok(!tags.includes('but'))
  assert.ok(!tags.includes('the'))
  assert.ok(tags.includes('gateway'))
  assert.ok(tags.includes('dispatcher'))
})

// ── 3. runLlm happy path via dispatcher ─────────────────
test('dispatcher runs llm engine and returns parsed tags', async () => {
  registerTask('auto_tags_for_memory', {
    heuristic: runHeuristic,
    llm: runLlm,
  })

  _setFetchImplForTests((async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    if (url.includes('/api/llm/chat-complete')) {
      return new Response(JSON.stringify(chatResponseFixture()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`unexpected url: ${url}`)
  }) as typeof fetch)

  const { result, metadata } = await runTask<{ content: string }, { tags: string[] }>(
    'auto_tags_for_memory',
    { content: 'CornMCP phase S7 dispatcher gateway' },
    TEST_ENV,
    { config: configFixture({ engine: 'llm' }) },
  )

  assert.equal(metadata.engineUsed, 'llm')
  assert.equal(metadata.fellBack, false)
  assert.deepEqual(result.tags, ['dispatcher', 'gateway', 'llm', 'phase', 'sprint'])
})

// ── 4. runLlm strips code fences ────────────────────────
test('runLlm parses tags wrapped in ```json ... ``` code fence', async () => {
  registerTask('auto_tags_for_memory', {
    heuristic: runHeuristic,
    llm: runLlm,
  })

  _setFetchImplForTests((async () =>
    new Response(JSON.stringify(chatResponseFixture({
      content: '```json\n{"tags":["alpha","beta","gamma"]}\n```',
    })), { status: 200, headers: { 'Content-Type': 'application/json' } })
  ) as typeof fetch)

  const { result } = await runTask<{ content: string }, { tags: string[] }>(
    'auto_tags_for_memory',
    { content: 'whatever' },
    TEST_ENV,
    { config: configFixture({ engine: 'llm' }) },
  )

  assert.deepEqual(result.tags, ['alpha', 'beta', 'gamma'])
})

// ── 5. LLM error → fallback to heuristic when allowed ──
test('dispatcher falls back to heuristic when llm response is malformed', async () => {
  registerTask('auto_tags_for_memory', {
    heuristic: runHeuristic,
    llm: runLlm,
  })

  _setFetchImplForTests((async () =>
    new Response(JSON.stringify(chatResponseFixture({ content: 'not-json' })), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  ) as typeof fetch)

  const { result, metadata } = await runTask<{ content: string }, { tags: string[] }>(
    'auto_tags_for_memory',
    { content: 'dispatcher gateway corn cornmcp dispatcher' },
    TEST_ENV,
    { config: configFixture({ engine: 'llm', fallback_to_heuristic: 1 }) },
  )

  assert.equal(metadata.engineUsed, 'heuristic')
  assert.equal(metadata.fellBack, true)
  assert.match(metadata.llmError ?? '', /not valid JSON/)
  assert.ok(result.tags.includes('dispatcher'))
  assert.ok(result.tags.includes('gateway'))
})
