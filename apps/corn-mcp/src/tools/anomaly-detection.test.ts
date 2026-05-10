import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  runHeuristic,
  parseLlmJson,
  registerAnomalyDetectionTask,
  ANOMALY_DETECTION_TASK_NAME,
  DEFAULT_Z_THRESHOLD,
  type AnomalyInput,
  type AnomalyResult,
} from './anomaly-detection.js'
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
    task_name: ANOMALY_DETECTION_TASK_NAME,
    engine: 'llm',
    provider_id: 'test-provider',
    model: 'gpt-4o-mini',
    enabled: 1,
    fallback_to_heuristic: 1,
    prompt_template: null,
    timeout_ms: 30_000,
    max_input_tokens: 8000,
    max_output_tokens: 600,
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
      inputTokens: 100,
      outputTokens: 80,
      costUsd: 0.0003,
      latencyMs: 140,
      cached: false,
      providerId: 'test-provider',
      provider: 'openai',
      model: 'gpt-4o-mini',
      tokensEstimated: false,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('anomaly-detection — heuristic', () => {
  test('DEFAULT_Z_THRESHOLD is 2', () => {
    assert.equal(DEFAULT_Z_THRESHOLD, 2)
  })

  test('flags spike with z ≥ 2 using provided baseline', () => {
    const res = runHeuristic({
      metrics: [
        {
          name: 'cost',
          values: [0.1, 0.12, 0.11, 5.0],
          baseline: { mean: 0.11, stddev: 0.01 },
        },
      ],
    })
    assert.equal(res.anomalies.length, 1)
    assert.equal(res.anomalies[0]!.metric, 'cost')
    assert.equal(res.anomalies[0]!.index, 3)
    assert.equal(res.anomalies[0]!.severity, 'high')
    assert.ok(res.anomalies[0]!.reason.includes('z='))
  })

  test('no anomalies when everything sits within threshold', () => {
    const res = runHeuristic({
      metrics: [
        { name: 'latency', values: [100, 102, 98, 101], baseline: { mean: 100, stddev: 2 } },
      ],
    })
    assert.equal(res.anomalies.length, 0)
    assert.equal(res.baselines[0]!.source, 'provided')
  })

  test('derives baseline from first 80% when none supplied', () => {
    const res = runHeuristic({
      metrics: [
        {
          name: 'latency',
          values: [100, 100, 100, 100, 100, 100, 100, 100, 1000, 1000],
        },
      ],
    })
    assert.equal(res.baselines[0]!.source, 'derived')
    // With stddev=0 on the derived baseline the z-score is NaN → no flag.
    // Use a small-variance series to verify flagging works.
    const res2 = runHeuristic({
      metrics: [
        { name: 'x', values: [10, 11, 9, 10, 10, 9, 11, 10, 50, 12] },
      ],
    })
    // Position 8 (value 50) should be flagged given the low-variance baseline.
    const flagged = res2.anomalies.some((a) => a.index === 8 && a.metric === 'x')
    assert.equal(flagged, true)
  })

  test('records baseline=none for empty values', () => {
    const res = runHeuristic({ metrics: [{ name: 'nope', values: [] }] })
    assert.equal(res.baselines[0]!.source, 'none')
    assert.equal(res.anomalies.length, 0)
  })

  test('zThreshold override is honored', () => {
    const res = runHeuristic({
      zThreshold: 4,
      metrics: [
        {
          name: 'cost',
          values: [0.1, 0.12, 0.11, 0.5],
          baseline: { mean: 0.11, stddev: 0.05 },
        },
      ],
    })
    // With z=~7.8 this still flags at threshold 4.
    assert.equal(res.anomalies.length, 1)
    // But at threshold 100 nothing should flag.
    const strict = runHeuristic({
      zThreshold: 100,
      metrics: [
        {
          name: 'cost',
          values: [0.1, 0.12, 0.11, 0.5],
          baseline: { mean: 0.11, stddev: 0.05 },
        },
      ],
    })
    assert.equal(strict.anomalies.length, 0)
  })

  test('sorts anomalies high → medium → low', () => {
    const res = runHeuristic({
      metrics: [
        { name: 'a', values: [1, 1, 1, 1, 10], baseline: { mean: 1, stddev: 1 } }, // z=9 → high
        { name: 'b', values: [1, 1, 1, 1, 3.5], baseline: { mean: 1, stddev: 1 } }, // z=2.5 → medium
      ],
    })
    const severities = res.anomalies.map((a) => a.severity)
    assert.equal(severities[0], 'high')
    assert.equal(severities.includes('medium'), true)
    const highIdx = severities.indexOf('high')
    const medIdx = severities.indexOf('medium')
    assert.ok(highIdx < medIdx)
  })
})

describe('anomaly-detection — parseLlmJson', () => {
  const input: AnomalyInput = {
    metrics: [{ name: 'cost', values: [0.1, 0.2, 5.0] }],
  }

  test('happy path returns findings', () => {
    const out = parseLlmJson(
      '{"anomalies":[{"metric":"cost","index":2,"value":5.0,"severity":"high","reason":"spike"}]}',
      input,
    )
    assert.equal(out.length, 1)
    assert.equal(out[0]!.metric, 'cost')
    assert.equal(out[0]!.index, 2)
    assert.equal(out[0]!.severity, 'high')
  })

  test('drops hallucinated metric name', () => {
    const out = parseLlmJson(
      '{"anomalies":[{"metric":"ghost","index":0,"value":1,"severity":"high"}]}',
      input,
    )
    assert.equal(out.length, 0)
  })

  test('drops out-of-range index', () => {
    const out = parseLlmJson(
      '{"anomalies":[{"metric":"cost","index":99,"value":1,"severity":"high"}]}',
      input,
    )
    assert.equal(out.length, 0)
  })

  test('missing severity defaults to medium', () => {
    const out = parseLlmJson(
      '{"anomalies":[{"metric":"cost","index":2,"value":5.0}]}',
      input,
    )
    assert.equal(out.length, 1)
    assert.equal(out[0]!.severity, 'medium')
  })

  test('code fenced json is unwrapped', () => {
    const out = parseLlmJson(
      '```json\n{"anomalies":[{"metric":"cost","index":2,"value":5,"severity":"high"}]}\n```',
      input,
    )
    assert.equal(out.length, 1)
  })

  test('empty anomalies array is valid', () => {
    const out = parseLlmJson('{"anomalies":[]}', input)
    assert.equal(out.length, 0)
  })

  test('malformed JSON throws', () => {
    assert.throws(() => parseLlmJson('not json', input), /not valid JSON/)
  })

  test('missing anomalies array throws', () => {
    assert.throws(() => parseLlmJson('{"foo":[]}', input), /invalid `anomalies` array/)
  })
})

describe('anomaly-detection — dispatcher integration', () => {
  beforeEach(() => {
    _resetFetchImplForTests()
    _resetTaskConfigCacheForTests()
    _resetTaskRegistryForTests()
    registerAnomalyDetectionTask()
  })

  afterEach(() => {
    _resetFetchImplForTests()
    _resetTaskConfigCacheForTests()
    _resetTaskRegistryForTests()
  })

  test('llm happy path returns parsed anomalies', async () => {
    _setFetchImplForTests(async () =>
      makeChatResponse(
        '{"anomalies":[{"metric":"cost","index":2,"value":5,"severity":"high","reason":"spike"}]}',
      ),
    )
    const { result, metadata } = await runTask<AnomalyInput, AnomalyResult>(
      ANOMALY_DETECTION_TASK_NAME,
      {
        metrics: [
          { name: 'cost', values: [0.1, 0.2, 5.0], baseline: { mean: 0.15, stddev: 0.05 } },
        ],
      },
      env,
      { config: makeConfig() },
    )
    assert.equal(metadata.engineUsed, 'llm')
    assert.equal(result.anomalies.length, 1)
    assert.equal(result.anomalies[0]!.index, 2)
    // Baselines still surfaced via heuristic helper.
    assert.equal(result.baselines.length, 1)
    assert.equal(result.baselines[0]!.source, 'provided')
  })

  test('llm malformed → fallback to heuristic', async () => {
    _setFetchImplForTests(async () => makeChatResponse('garbage'))
    const { result, metadata } = await runTask<AnomalyInput, AnomalyResult>(
      ANOMALY_DETECTION_TASK_NAME,
      {
        metrics: [
          { name: 'x', values: [1, 1, 1, 1, 10], baseline: { mean: 1, stddev: 1 } },
        ],
      },
      env,
      { config: makeConfig() },
    )
    assert.equal(metadata.engineUsed, 'heuristic')
    assert.equal(metadata.fellBack, true)
    assert.equal(result.anomalies.length, 1)
  })

  test('empty metrics short-circuits without fetch', async () => {
    let calls = 0
    _setFetchImplForTests(async () => {
      calls++
      return makeChatResponse('{"anomalies":[]}')
    })
    const { result } = await runTask<AnomalyInput, AnomalyResult>(
      ANOMALY_DETECTION_TASK_NAME,
      { metrics: [] },
      env,
      { config: makeConfig() },
    )
    assert.equal(calls, 0)
    assert.deepEqual(result.anomalies, [])
  })

  test('registerAnomalyDetectionTask is idempotent', () => {
    registerAnomalyDetectionTask()
    registerAnomalyDetectionTask()
  })
})
