// Session-summary (S7.3) tests. Pure unit tests for `runHeuristic` plus
// dispatcher-integration tests for the LLM path that mock
// `chatCompleteRemote` via the `_setFetchImplForTests` injection seam
// from task-dispatcher.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  runHeuristic,
  runLlm,
  registerSessionSummaryTask,
  SESSION_SUMMARY_TASK_NAME,
  DEFAULT_HEURISTIC_MAX_CHARS,
  type SessionSummaryInput,
  type SessionSummaryResult,
} from './session-summary.js'
import {
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
    task_name: SESSION_SUMMARY_TASK_NAME,
    engine: 'heuristic',
    provider_id: null,
    model: 'gpt-4o-mini',
    enabled: 1,
    fallback_to_heuristic: 1,
    prompt_template: null,
    timeout_ms: 30_000,
    max_input_tokens: 8000,
    max_output_tokens: 400,
    temperature: 0.3,
    cache_ttl_sec: 3600,
    cost_cap_usd_per_day: 0,
    description: null,
    ...overrides,
  }
}

function chatResponseFixture(overrides: Partial<RemoteChatResponse> = {}): RemoteChatResponse {
  return {
    content: 'Đã hoàn tất phase S7.2 auto-tag. Test 20/20 PASS. Tiếp theo S7.3.',
    inputTokens: 200,
    outputTokens: 30,
    costUsd: 0.0002,
    latencyMs: 200,
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

// ── 1. Heuristic: short text passes through unchanged ──
test('runHeuristic returns short text unchanged', () => {
  const text = 'Done in one line.'
  const out = runHeuristic({ text })
  assert.equal(out.summary, text)
})

test('runHeuristic returns empty for empty input', () => {
  assert.equal(runHeuristic({ text: '' }).summary, '')
  assert.equal(runHeuristic({ text: '   \n\t  ' }).summary, '')
  assert.equal(runHeuristic({ text: null as unknown as string }).summary, '')
})

// ── 2. Heuristic: sentence-aware truncation ────────────
test('runHeuristic keeps whole sentences under maxChars', () => {
  // 5 sentences, each ~80 chars. Default cap 400 should fit ~4-5.
  const sentences = [
    'First sentence about the dispatcher and how the task engine routes calls.',
    'Second sentence covering the LLM fallback logic when providers are down.',
    'Third sentence about cost cap enforcement and per-task daily limits.',
    'Fourth sentence describing the audit trail and per-field diff capture.',
    'Fifth sentence about the admin UI for toggling engines per task.',
    'Sixth sentence we expect to be dropped because total exceeds 400 chars.',
  ]
  const text = sentences.join(' ')
  const { summary } = runHeuristic({ text })
  assert.ok(summary.length <= DEFAULT_HEURISTIC_MAX_CHARS, `summary too long: ${summary.length}`)
  assert.ok(summary.startsWith('First sentence'), 'should start at the beginning')
  // Ends with a sentence terminator (full sentence kept)
  assert.match(summary, /[.!?…]$/, `summary should end at a sentence boundary, got: ${summary}`)
  // Sixth sentence text should not appear
  assert.ok(!summary.includes('Sixth sentence'), 'sixth sentence should be dropped')
})

test('runHeuristic falls back to word-boundary cut for a single very long sentence', () => {
  // One sentence, no terminator, guaranteed > 400 chars → no sentence
  // split possible → word-boundary truncation with ellipsis.
  const text =
    'This is a single very long sentence without any terminator that just keeps going and going ' +
    'word '.repeat(200)
  assert.ok(text.length > DEFAULT_HEURISTIC_MAX_CHARS, 'test input must exceed maxChars')
  const { summary } = runHeuristic({ text })
  assert.ok(summary.length <= DEFAULT_HEURISTIC_MAX_CHARS, `summary too long: ${summary.length}`)
  assert.ok(summary.endsWith('…'), `expected ellipsis suffix, got tail: "${summary.slice(-20)}"`)
  assert.ok(summary.startsWith('This is a single very long sentence'))
})

test('runHeuristic respects custom maxChars', () => {
  const text = 'One. Two. Three. Four. Five.'
  const { summary } = runHeuristic({ text, maxChars: 10 })
  // Only "One." fits under 10 chars (4 chars). "One. Two." is 9 chars → also fits.
  assert.ok(summary.length <= 10)
  assert.ok(summary.startsWith('One'))
})

// ── 3. LLM happy path via dispatcher ───────────────────
test('dispatcher runs llm engine and returns trimmed summary', async () => {
  registerSessionSummaryTask()

  _setFetchImplForTests((async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    if (url.includes('/api/llm/chat-complete')) {
      return new Response(JSON.stringify(chatResponseFixture({
        content: '  Compressed summary in two sentences. Done.  ',
      })), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    throw new Error(`unexpected url: ${url}`)
  }) as typeof fetch)

  const longLog = 'A'.repeat(2000)
  const { result, metadata } = await runTask<SessionSummaryInput, SessionSummaryResult>(
    SESSION_SUMMARY_TASK_NAME,
    { text: longLog },
    TEST_ENV,
    { config: configFixture({ engine: 'llm' }) },
  )

  assert.equal(metadata.engineUsed, 'llm')
  assert.equal(metadata.fellBack, false)
  assert.equal(result.summary, 'Compressed summary in two sentences. Done.')
})

// ── 4. LLM empty output → fallback to heuristic ────────
test('dispatcher falls back to heuristic when llm returns empty content', async () => {
  registerSessionSummaryTask()

  _setFetchImplForTests((async () =>
    new Response(JSON.stringify(chatResponseFixture({ content: '   ' })), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  ) as typeof fetch)

  const longText = 'First sentence about the dispatcher. ' + 'Filler. '.repeat(100)
  const { result, metadata } = await runTask<SessionSummaryInput, SessionSummaryResult>(
    SESSION_SUMMARY_TASK_NAME,
    { text: longText },
    TEST_ENV,
    { config: configFixture({ engine: 'llm', fallback_to_heuristic: 1 }) },
  )

  assert.equal(metadata.engineUsed, 'heuristic')
  assert.equal(metadata.fellBack, true)
  assert.match(metadata.llmError ?? '', /empty summary/)
  assert.ok(result.summary.startsWith('First sentence'))
  assert.ok(result.summary.length <= DEFAULT_HEURISTIC_MAX_CHARS)
})

// ── 5. LLM error → fallback when fallback=1 ────────────
test('dispatcher falls back to heuristic when llm fetch errors', async () => {
  registerSessionSummaryTask()

  _setFetchImplForTests(async () => {
    throw new Error('network down')
  })

  const text = 'Heuristic must take over. Second sentence here.'
  const { result, metadata } = await runTask<SessionSummaryInput, SessionSummaryResult>(
    SESSION_SUMMARY_TASK_NAME,
    { text },
    TEST_ENV,
    { config: configFixture({ engine: 'llm', fallback_to_heuristic: 1 }) },
  )

  assert.equal(metadata.engineUsed, 'heuristic')
  assert.equal(metadata.fellBack, true)
  assert.equal(result.summary, text)
})

// ── 6. registerSessionSummaryTask is idempotent ────────
test('registerSessionSummaryTask is idempotent across multiple calls', async () => {
  registerSessionSummaryTask()
  registerSessionSummaryTask()
  registerSessionSummaryTask()

  // After triple-register, the task should still resolve and run.
  const { result, metadata } = await runTask<SessionSummaryInput, SessionSummaryResult>(
    SESSION_SUMMARY_TASK_NAME,
    { text: 'Short. Done.' },
    TEST_ENV,
    { config: configFixture({ engine: 'heuristic' }) },
  )
  assert.equal(metadata.engineUsed, 'heuristic')
  assert.equal(result.summary, 'Short. Done.')
})
