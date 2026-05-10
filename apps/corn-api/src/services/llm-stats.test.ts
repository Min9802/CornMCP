// LLM stats aggregation (S6.4) integration tests. Backed by an
// in-memory MongoDB replica-set (mongodb-memory-server) — same pattern
// as task-engines.test.ts.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { MongoMemoryReplSet } from 'mongodb-memory-server'

process.env['SYSTEM_SETTINGS_MASTER_KEY'] = 'unit-test-master-key-do-not-use-in-prod'
delete process.env['AUTH_JWT_SECRET']
process.env['SYSTEM_SETTINGS_CACHE_TTL_MS'] = '50'
process.env['DATABASE_DRIVER'] = 'mongo'

const { setupTestMongo, teardownTestMongo } = await import('../test-utils/mongo.js')
const { getLlmStats, getCostCapStatus } = await import('./llm-stats.js')
const { setSetting, _clearSettingsCacheForTests } = await import('./settings.js')
const { LlmGatewayLog } = await import('../db/mongoose/index.js')

let replSet: MongoMemoryReplSet

before(async () => {
  replSet = await setupTestMongo()
})

after(async () => {
  await teardownTestMongo(replSet)
})

// Insert a synthetic gateway log row. Times are passed explicitly so
// tests can plant rows in distinct days for windowing assertions.
async function logRow(opts: {
  task?: string | null
  provider?: string | null
  model?: string | null
  cost?: number
  latency?: number
  cached?: boolean
  error?: string | null
  inputTokens?: number
  outputTokens?: number
  ageHours?: number
}): Promise<void> {
  const ageH = opts.ageHours ?? 0
  const created = new Date(Date.now() - ageH * 60 * 60 * 1000)
  await LlmGatewayLog.create({
    task_name: opts.task ?? null,
    provider_id: opts.provider ? `prov-${opts.provider}` : null,
    provider: opts.provider ?? null,
    model: opts.model ?? null,
    input_tokens: opts.inputTokens ?? 100,
    output_tokens: opts.outputTokens ?? 50,
    cost_usd: opts.cost ?? 0.001,
    latency_ms: opts.latency ?? 200,
    cached: opts.cached ?? false,
    error: opts.error ?? null,
    created_at: created,
  } as unknown as Parameters<typeof LlmGatewayLog.create>[0])
}

// ── 1. Empty DB → zero stats, no breakdowns ────────────
test('getLlmStats returns zeroed totals when there are no logs', async () => {
  await LlmGatewayLog.deleteMany({})

  const stats = await getLlmStats(7)
  assert.equal(stats.windowDays, 7)
  assert.equal(stats.totals.totalCalls, 0)
  assert.equal(stats.totals.totalCostUsd, 0)
  assert.equal(stats.totals.cacheHitRate, 0)
  assert.equal(stats.byTask.length, 0)
  assert.equal(stats.byProvider.length, 0)
  assert.equal(stats.byModel.length, 0)
  assert.equal(stats.recentErrors.length, 0)
})

// ── 2. Aggregate stats happy path ──────────────────────
test('getLlmStats aggregates totals + per-task + per-provider correctly', async () => {
  await LlmGatewayLog.deleteMany({})

  // Day 0: 4 successful (2 cached, 2 live), 1 errored, mixed providers
  await logRow({ task: 'plan_quality',     provider: 'openai',    model: 'gpt-4o-mini', cost: 0.01,  cached: false, latency: 300 })
  await logRow({ task: 'plan_quality',     provider: 'openai',    model: 'gpt-4o-mini', cost: 0,     cached: true,  latency: 0   })
  await logRow({ task: 'session_summary',  provider: 'anthropic', model: 'claude-3-5-haiku-20241022', cost: 0.02, cached: false, latency: 500 })
  await logRow({ task: 'session_summary',  provider: 'anthropic', model: 'claude-3-5-haiku-20241022', cost: 0,    cached: true,  latency: 0   })
  await logRow({ task: 'memory_dedup',     provider: 'gemini',    model: 'gemini-1.5-flash', error: 'rate limited', cost: 0, latency: 0 })

  const stats = await getLlmStats(1)
  assert.equal(stats.totals.totalCalls, 5)
  assert.equal(stats.totals.successfulCalls, 4)
  assert.equal(stats.totals.cachedCalls, 2)
  assert.equal(stats.totals.erroredCalls, 1)
  // Cost from successful, non-cached (errored row has cost=0 too): 0.01 + 0.02 = 0.03
  assert.ok(Math.abs(stats.totals.totalCostUsd - 0.03) < 1e-9)
  // Cache hit rate: 2/5 = 0.4
  assert.equal(stats.totals.cacheHitRate, 0.4)

  // By-task: plan_quality = 2 calls, $0.01; session_summary = 2 calls, $0.02; memory_dedup = 1 call, $0
  const planRow = stats.byTask.find((b) => b.key === 'plan_quality')!
  assert.ok(planRow)
  assert.equal(planRow.calls, 2)
  assert.ok(Math.abs(planRow.costUsd - 0.01) < 1e-9)

  // By-provider: 3 distinct providers
  const providers = stats.byProvider.map((b) => b.key).sort()
  assert.deepEqual(providers, ['anthropic', 'gemini', 'openai'])

  // Recent errors: 1 row, captures the message
  assert.equal(stats.recentErrors.length, 1)
  assert.equal(stats.recentErrors[0]!.error, 'rate limited')
  assert.equal(stats.recentErrors[0]!.taskName, 'memory_dedup')
})

// ── 3. cost-cap-status reflects DB spent vs setting ────
test('getCostCapStatus returns spent + cap + warning thresholds', async () => {
  await LlmGatewayLog.deleteMany({})
  // 0.85 USD spent today
  await logRow({ task: 't1', provider: 'openai', model: 'm', cost: 0.5 })
  await logRow({ task: 't2', provider: 'openai', model: 'm', cost: 0.35 })
  // Errored row should NOT count toward spent
  await logRow({ task: 't3', provider: 'openai', model: 'm', cost: 999, error: 'boom' })

  // Cap = 1.0 → 85% used → warning=true, exceeded=false
  await setSetting('llm.cost_cap_usd_per_day', '1.0', { category: 'llm', isSecret: false, updatedBy: 'test' })
  _clearSettingsCacheForTests()
  let status = await getCostCapStatus()
  assert.ok(Math.abs(status.spentUsd - 0.85) < 1e-9, `expected 0.85 got ${status.spentUsd}`)
  assert.equal(status.capUsd, 1.0)
  assert.equal(status.warning, true)
  assert.equal(status.exceeded, false)
  assert.ok(status.pctUsed !== null && Math.abs(status.pctUsed - 0.85) < 1e-9)

  // Cap = 0.5 → exceeded
  await setSetting('llm.cost_cap_usd_per_day', '0.5', { category: 'llm', isSecret: false, updatedBy: 'test' })
  _clearSettingsCacheForTests()
  status = await getCostCapStatus()
  assert.equal(status.exceeded, true)
  assert.equal(status.warning, true)

  // Cap = 0 → disabled (pctUsed null, no warnings)
  await setSetting('llm.cost_cap_usd_per_day', '0', { category: 'llm', isSecret: false, updatedBy: 'test' })
  _clearSettingsCacheForTests()
  status = await getCostCapStatus()
  assert.equal(status.capUsd, 0)
  assert.equal(status.pctUsed, null)
  assert.equal(status.warning, false)
  assert.equal(status.exceeded, false)
})
