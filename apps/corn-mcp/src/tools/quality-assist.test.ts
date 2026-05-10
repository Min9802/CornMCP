// Quality-assist (S7.4) tests. Unit tests for `runHeuristic` +
// `parseLlmJson` plus dispatcher-integration tests for the LLM path
// that mock `chatCompleteRemote` via the `_setFetchImplForTests`
// injection seam from task-dispatcher.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  runHeuristic,
  parseLlmJson,
  registerQualityAssistTask,
  QUALITY_ASSIST_TASK_NAME,
  type QualityAssistInput,
  type QualityAssistResult,
} from './quality-assist.js'
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
    task_name: QUALITY_ASSIST_TASK_NAME,
    engine: 'heuristic',
    provider_id: null,
    model: 'gpt-4o-mini',
    enabled: 1,
    fallback_to_heuristic: 1,
    prompt_template: null,
    timeout_ms: 30_000,
    max_input_tokens: 8000,
    max_output_tokens: 600,
    temperature: 0.2,
    cache_ttl_sec: 3600,
    cost_cap_usd_per_day: 0,
    description: null,
    ...overrides,
  }
}

function chatResponseFixture(overrides: Partial<RemoteChatResponse> = {}): RemoteChatResponse {
  return {
    content: '',
    inputTokens: 200,
    outputTokens: 60,
    costUsd: 0.0003,
    latencyMs: 180,
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

// ── 1. Heuristic: zero context → low scores + guidance reasoning ──
test('runHeuristic returns low scores and guidance when no context supplied', () => {
  const out = runHeuristic({})
  // Zero-context total must be well below 60 so the assist doesn't
  // accidentally pass a quality gate on an empty submission.
  const total = out.scoreBuild + out.scoreRegression + out.scoreStandards + out.scoreTraceability
  assert.ok(total < 60, `expected total < 60 for empty input, got ${total}`)
  assert.match(out.reasoning, /no change context/i)
})

// ── 2. Heuristic: explicit test pass lifts build + regression ──
test('runHeuristic with passing tests and changed test files lifts build + regression', () => {
  const input: QualityAssistInput = {
    summary: 'Refactor dispatcher and add fallback tests for S7.4 quality-assist task.',
    changedFiles: [
      'apps/corn-mcp/src/tools/quality-assist.ts',
      'apps/corn-mcp/src/tools/quality-assist.test.ts',
      'apps/corn-mcp/src/tools/quality.ts',
    ],
    testResults: '12/12 PASS in 234ms',
  }
  const out = runHeuristic(input)
  assert.ok(out.scoreBuild >= 20, `build should be ≥20 with passing tests, got ${out.scoreBuild}`)
  assert.ok(
    out.scoreRegression >= 15,
    `regression should be ≥15 with 1 test file + N/N PASS, got ${out.scoreRegression}`,
  )
  assert.match(out.reasoning, /tests passing/i)
  assert.match(out.reasoning, /test file/i)
})

// ── 3. Heuristic: failing tests drag build hard ──
test('runHeuristic with failing tests pushes build score low', () => {
  const out = runHeuristic({
    summary: 'Fix bug',
    changedFiles: ['src/a.ts', 'src/b.ts'],
    testResults: '2 FAIL, 3 ERROR',
  })
  assert.ok(out.scoreBuild <= 10, `expected ≤10 with fails, got ${out.scoreBuild}`)
  assert.match(out.reasoning, /tests failing/i)
})

// ── 4. Heuristic: no tests touched + 3+ non-test files → regression hit ──
test('runHeuristic penalizes regression when no test files changed on non-trivial change', () => {
  const out = runHeuristic({
    summary: 'Refactored core service and added new route',
    changedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
  })
  // Base 10 − 4 penalty = 6, but still needs to pass clamp ≥ 0
  assert.ok(out.scoreRegression <= 8, `expected ≤8 when no test files, got ${out.scoreRegression}`)
  assert.match(out.reasoning, /no tests touched/i)
})

// ── 5. Heuristic: detailed summary + issue ref boosts traceability ──
test('runHeuristic boosts traceability for detailed summary with issue ref', () => {
  const longSummary =
    'Session 2026-05-10 — Phase S7.4 quality_report_assist. Closes #42. ' +
    'Added heuristic scoring rubric covering build/regression/standards/traceability, ' +
    'plus LLM JSON extraction with clamp + soft-fail. '.repeat(3)

  const out = runHeuristic({
    summary: longSummary,
    changedFiles: ['x.ts'],
  })
  // Base 12 + ≥80 (+4) + ≥200 (+3) + ≥500 (+2) + issue ref (+3) = up to 24.
  assert.ok(out.scoreTraceability >= 20, `expected ≥20, got ${out.scoreTraceability}`)
  assert.match(out.reasoning, /detailed summary/i)
  assert.match(out.reasoning, /issue referenced/i)
})

// ── 6. Heuristic: lint-clean + typecheck-pass mentions boost standards ──
test('runHeuristic boosts standards when lint and typecheck mentioned', () => {
  const out = runHeuristic({
    summary: 'Passing lint clean, typecheck pass 8/8 turbo, build green.',
    changedFiles: ['a.ts'],
    testResults: '20/20 PASS',
  })
  assert.ok(out.scoreStandards >= 22, `expected ≥22, got ${out.scoreStandards}`)
  assert.match(out.reasoning, /lint clean/i)
})

// ── 7. Heuristic: scores clamp into [0, 25] ──
test('runHeuristic scores are always clamped to [0, 25]', () => {
  // 10 test files + passing + detailed summary = try to exceed 25.
  const manyTestFiles = Array.from({ length: 10 }, (_, i) => `tests/spec${i}.test.ts`)
  const out = runHeuristic({
    summary: 'A'.repeat(600),
    changedFiles: manyTestFiles,
    testResults: '100/100 PASS',
  })
  for (const key of ['scoreBuild', 'scoreRegression', 'scoreStandards', 'scoreTraceability'] as const) {
    assert.ok(out[key] >= 0 && out[key] <= 25, `${key}=${out[key]} out of range`)
  }
})

// ── 8. parseLlmJson happy path ──
test('parseLlmJson extracts all 4 scores + reasoning', () => {
  const content = JSON.stringify({
    scoreBuild: 22,
    scoreRegression: 18,
    scoreStandards: 20,
    scoreTraceability: 17,
    reasoning: 'Tests green, lint clean, narrow scope, issue linked.',
  })
  const out = parseLlmJson(content, {})
  assert.equal(out.scoreBuild, 22)
  assert.equal(out.scoreRegression, 18)
  assert.equal(out.scoreStandards, 20)
  assert.equal(out.scoreTraceability, 17)
  assert.match(out.reasoning, /tests green/i)
})

// ── 9. parseLlmJson strips code fences ──
test('parseLlmJson strips ```json fences before parsing', () => {
  const content = '```json\n{"scoreBuild":25,"scoreRegression":25,"scoreStandards":25,"scoreTraceability":25,"reasoning":"excellent"}\n```'
  const out = parseLlmJson(content, {})
  assert.equal(out.scoreBuild, 25)
  assert.equal(out.scoreTraceability, 25)
  assert.equal(out.reasoning, 'excellent')
})

// ── 10. parseLlmJson clamps + coerces numeric values ──
test('parseLlmJson clamps out-of-range and coerces string numbers', () => {
  const content = JSON.stringify({
    scoreBuild: 40,        // > 25 → 25
    scoreRegression: -5,   // < 0 → 0
    scoreStandards: '18',  // string → 18
    scoreTraceability: 12.8, // round → 13
    reasoning: '',
  })
  const out = parseLlmJson(content, {})
  assert.equal(out.scoreBuild, 25)
  assert.equal(out.scoreRegression, 0)
  assert.equal(out.scoreStandards, 18)
  assert.equal(out.scoreTraceability, 13)
  assert.equal(out.reasoning, '')
})

// ── 11. parseLlmJson soft-fails missing dims → heuristic fallback ──
test('parseLlmJson uses heuristic fallback for missing numeric fields', () => {
  // Only scoreBuild supplied; the others must come from the heuristic
  // computed against the given input (which has a lint-clean signal).
  const content = JSON.stringify({ scoreBuild: 24, reasoning: 'partial' })
  const input: QualityAssistInput = {
    summary: 'Lint clean, typecheck pass. Fixes #7.',
    changedFiles: ['a.ts'],
  }
  const out = parseLlmJson(content, input)
  assert.equal(out.scoreBuild, 24) // from LLM
  // Heuristic should set standards ≥ 22 with lint+typecheck; fallback
  // must surface that value instead of throwing.
  assert.ok(out.scoreStandards >= 20, `fallback standards should be ≥20, got ${out.scoreStandards}`)
  // All dims should still be numbers in range.
  assert.ok(out.scoreRegression >= 0 && out.scoreRegression <= 25)
  assert.ok(out.scoreTraceability >= 0 && out.scoreTraceability <= 25)
})

// ── 12. parseLlmJson throws on malformed JSON ──
test('parseLlmJson throws on malformed JSON to trigger dispatcher fallback', () => {
  assert.throws(() => parseLlmJson('not json at all', {}), /not valid JSON/i)
  assert.throws(() => parseLlmJson('null', {}), /root object/i)
  assert.throws(() => parseLlmJson('"string"', {}), /root object/i)
})

// ── 13. Dispatcher LLM happy path ──
test('dispatcher runs llm engine and returns LLM-supplied scores', async () => {
  registerQualityAssistTask()

  const fixture = JSON.stringify({
    scoreBuild: 23,
    scoreRegression: 21,
    scoreStandards: 22,
    scoreTraceability: 20,
    reasoning: 'Tests green, tight scope, all dims healthy.',
  })

  _setFetchImplForTests((async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    if (url.includes('/api/llm/chat-complete')) {
      return new Response(JSON.stringify(chatResponseFixture({ content: fixture })), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`unexpected url: ${url}`)
  }) as typeof fetch)

  const { result, metadata } = await runTask<QualityAssistInput, QualityAssistResult>(
    QUALITY_ASSIST_TASK_NAME,
    { summary: 'Tight PR with green tests', changedFiles: ['a.ts', 'a.test.ts'] },
    TEST_ENV,
    { config: configFixture({ engine: 'llm' }) },
  )

  assert.equal(metadata.engineUsed, 'llm')
  assert.equal(metadata.fellBack, false)
  assert.equal(result.scoreBuild, 23)
  assert.equal(result.scoreTraceability, 20)
  assert.match(result.reasoning, /tests green/i)
})

// ── 14. Dispatcher falls back to heuristic on malformed JSON ──
test('dispatcher falls back to heuristic when llm returns non-JSON', async () => {
  registerQualityAssistTask()

  _setFetchImplForTests((async () =>
    new Response(JSON.stringify(chatResponseFixture({ content: 'sorry, I cannot answer that' })), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  ) as typeof fetch)

  const { result, metadata } = await runTask<QualityAssistInput, QualityAssistResult>(
    QUALITY_ASSIST_TASK_NAME,
    {
      summary: 'Lint clean. 20/20 PASS.',
      changedFiles: ['x.ts', 'x.test.ts'],
      testResults: '20/20 PASS',
    },
    TEST_ENV,
    { config: configFixture({ engine: 'llm', fallback_to_heuristic: 1 }) },
  )

  assert.equal(metadata.engineUsed, 'heuristic')
  assert.equal(metadata.fellBack, true)
  assert.match(metadata.llmError ?? '', /not valid JSON/i)
  // Heuristic should still produce a healthy result given positive signals.
  assert.ok(result.scoreBuild >= 20)
})

// ── 15. Dispatcher falls back when network errors ──
test('dispatcher falls back to heuristic when llm fetch errors with fallback=1', async () => {
  registerQualityAssistTask()

  _setFetchImplForTests(async () => {
    throw new Error('ECONNREFUSED')
  })

  const { result, metadata } = await runTask<QualityAssistInput, QualityAssistResult>(
    QUALITY_ASSIST_TASK_NAME,
    { summary: 'Small fix', changedFiles: ['a.ts'] },
    TEST_ENV,
    { config: configFixture({ engine: 'llm', fallback_to_heuristic: 1 }) },
  )

  assert.equal(metadata.engineUsed, 'heuristic')
  assert.equal(metadata.fellBack, true)
  assert.ok(typeof result.scoreBuild === 'number')
})

// ── 16. Dispatcher rethrows when fallback=0 ──
test('dispatcher rethrows llm error when fallback_to_heuristic=0', async () => {
  registerQualityAssistTask()

  _setFetchImplForTests(async () => {
    throw new Error('ECONNREFUSED')
  })

  await assert.rejects(
    runTask<QualityAssistInput, QualityAssistResult>(
      QUALITY_ASSIST_TASK_NAME,
      { summary: 'x' },
      TEST_ENV,
      { config: configFixture({ engine: 'llm', fallback_to_heuristic: 0 }) },
    ),
    /ECONNREFUSED/,
  )
})

// ── 17. registerQualityAssistTask is idempotent ──
test('registerQualityAssistTask is idempotent across multiple calls', async () => {
  registerQualityAssistTask()
  registerQualityAssistTask()
  registerQualityAssistTask()

  const { result, metadata } = await runTask<QualityAssistInput, QualityAssistResult>(
    QUALITY_ASSIST_TASK_NAME,
    { summary: 'Tiny patch', changedFiles: ['a.ts'] },
    TEST_ENV,
    { config: configFixture({ engine: 'heuristic' }) },
  )
  assert.equal(metadata.engineUsed, 'heuristic')
  assert.ok(typeof result.scoreBuild === 'number')
})
