// Task Engine Config (S5.2) integration tests. Backed by an in-memory
// MongoDB replica-set (mongodb-memory-server) so the suite never needs
// a real mongod and stays parallel-safe across test files.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { MongoMemoryReplSet } from 'mongodb-memory-server'

// Wire env BEFORE the dynamic imports below so any module-level reads
// (e.g. SYSTEM_SETTINGS_MASTER_KEY) see the right values.
process.env['SYSTEM_SETTINGS_MASTER_KEY'] = 'unit-test-master-key-do-not-use-in-prod'
delete process.env['AUTH_JWT_SECRET']
process.env['TASK_ENGINE_CACHE_TTL_MS'] = '100'
// Force the test process onto the mongo branch of the driver factory —
// otherwise initDatabase() would fail looking for a sql.js path.
process.env['DATABASE_DRIVER'] = 'mongo'

const { setupTestMongo, teardownTestMongo } = await import('../test-utils/mongo.js')
const {
  DEFAULT_TASK_ENGINES,
  getTaskEngineConfig,
  listTaskEngineConfigs,
  updateTaskEngineConfig,
  seedDefaultTaskEngines,
  getTaskEngineAudit,
  appendTaskEngineAudit,
  _clearTaskEngineCacheForTests,
} = await import('./task-engines.js')
const { TaskEngineConfig: TaskEngineConfigModel, TaskEngineAudit } = await import('../db/mongoose/index.js')

let replSet: MongoMemoryReplSet

before(async () => {
  replSet = await setupTestMongo()
})

after(async () => {
  await teardownTestMongo(replSet)
})

// ── 1. Default constant has the 10 expected tasks ──────
test('DEFAULT_TASK_ENGINES seeds the 10 plan-mandated tasks', () => {
  const names = DEFAULT_TASK_ENGINES.map((s) => s.taskName)
  for (const expected of [
    'plan_quality',
    'auto_tags_for_memory',
    'session_summary',
    'quality_report_assist',
    'memory_dedup',
    'code_search_rerank',
    'anomaly_detection',
    'token_count',
    'knowledge_dedup',
    'chat_assistant',
  ]) {
    assert.ok(names.includes(expected), `missing default task: ${expected}`)
  }
  assert.equal(DEFAULT_TASK_ENGINES.length, 10)
})

// ── 2. getTaskEngineConfig synthesizes a default for unknown task ─
test('getTaskEngineConfig returns synth default for unseeded task', async () => {
  // Wipe the collection so plan_quality definitely has no DB row.
  await TaskEngineConfigModel.deleteMany({})
  _clearTaskEngineCacheForTests()
  const cfg = await getTaskEngineConfig('plan_quality')
  // Synth fallback is heuristic.
  assert.equal(cfg.engine, 'heuristic')
  assert.equal(cfg.task_name, 'plan_quality')
  assert.equal(cfg.fallback_to_heuristic, 1)
  assert.equal(cfg.enabled, 1)
})

// ── 3. seedDefaultTaskEngines is idempotent ────────────
test('seedDefaultTaskEngines inserts missing rows + skips existing', async () => {
  await TaskEngineConfigModel.deleteMany({})
  _clearTaskEngineCacheForTests()

  const first = await seedDefaultTaskEngines()
  assert.equal(first.inserted.length, DEFAULT_TASK_ENGINES.length)

  // Second run = no-ops.
  const second = await seedDefaultTaskEngines()
  assert.equal(second.inserted.length, 0)

  const count = await TaskEngineConfigModel.countDocuments()
  assert.equal(count, DEFAULT_TASK_ENGINES.length)
})

// ── 4. updateTaskEngineConfig flips engine + invalidates cache ─
test('updateTaskEngineConfig flips engine and invalidates cache', async () => {
  // Prime the cache with a fresh read.
  _clearTaskEngineCacheForTests()
  const before = await getTaskEngineConfig('plan_quality')
  assert.equal(before.engine, 'heuristic')

  await updateTaskEngineConfig('plan_quality', {
    engine: 'llm',
    model: 'gpt-4o-mini',
    updatedBy: 'test-user',
  })

  // Cache MUST have been invalidated by the update — no manual clear here.
  const after = await getTaskEngineConfig('plan_quality')
  assert.equal(after.engine, 'llm')
  assert.equal(after.model, 'gpt-4o-mini')
  assert.equal(after.updated_by, 'test-user')
})

// ── 5. updateTaskEngineConfig validates types ──────────
test('updateTaskEngineConfig rejects bad numeric inputs', async () => {
  await assert.rejects(
    () => updateTaskEngineConfig('plan_quality', { temperature: 5 }),
    /temperature must be in/,
  )
  await assert.rejects(
    () => updateTaskEngineConfig('plan_quality', { timeoutMs: -1 }),
    /timeoutMs must be a positive/,
  )
  await assert.rejects(
    () => updateTaskEngineConfig('plan_quality', { maxOutputTokens: 0 }),
    /maxOutputTokens must be a positive/,
  )
})

// ── 6. updateTaskEngineConfig rejects unknown engine ────
test('updateTaskEngineConfig rejects engine value not in (heuristic|llm)', async () => {
  await assert.rejects(
    () =>
      updateTaskEngineConfig('plan_quality', {
        // @ts-expect-error — testing runtime validation
        engine: 'magic',
      }),
    /engine must be 'heuristic' or 'llm'/,
  )
})

// ── 7. listTaskEngineConfigs surfaces unseeded defaults ─
test('listTaskEngineConfigs merges DB rows + default seed', async () => {
  // DB only has plan_quality (set by test 4). Wipe everything else.
  await TaskEngineConfigModel.deleteMany({ _id: { $ne: 'plan_quality' } })
  _clearTaskEngineCacheForTests()

  const all = await listTaskEngineConfigs()
  // All 10 default tasks should be present even though only one is in DB.
  const names = all.map((c) => c.task_name)
  assert.equal(all.length, DEFAULT_TASK_ENGINES.length)
  for (const spec of DEFAULT_TASK_ENGINES) {
    assert.ok(names.includes(spec.taskName), `missing task: ${spec.taskName}`)
  }

  // The DB row for plan_quality should still report engine=llm from test 4.
  const planRow = all.find((c) => c.task_name === 'plan_quality')
  assert.equal(planRow!.engine, 'llm')

  // A non-DB task surfaces as default heuristic.
  const tokenRow = all.find((c) => c.task_name === 'token_count')
  assert.equal(tokenRow!.engine, 'heuristic')
})

// ── 8. updateTaskEngineConfig creates row when missing ─
test('updateTaskEngineConfig inserts a new row on first edit', async () => {
  await TaskEngineConfigModel.deleteMany({ _id: 'memory_dedup' })
  _clearTaskEngineCacheForTests()

  const result = await updateTaskEngineConfig('memory_dedup', {
    engine: 'llm',
    fallbackToHeuristic: false,
    temperature: 0.5,
    updatedBy: 'admin-user',
  })

  assert.equal(result.engine, 'llm')
  assert.equal(result.fallback_to_heuristic, 0)
  assert.equal(result.temperature, 0.5)
  assert.equal(result.updated_by, 'admin-user')

  const count = await TaskEngineConfigModel.countDocuments({ _id: 'memory_dedup' })
  assert.equal(count, 1)
})

// ── 9. Cache holds within TTL, expires after ──────────
test('getTaskEngineConfig cache holds within TTL and expires after', async () => {
  // Set engine=llm via the proper API so the cache is invalidated.
  await updateTaskEngineConfig('session_summary', { engine: 'llm', updatedBy: 'a' })
  const v1 = await getTaskEngineConfig('session_summary')
  assert.equal(v1.engine, 'llm')

  // Out-of-band update bypassing the service so the cache stays warm.
  await TaskEngineConfigModel.updateOne(
    { _id: 'session_summary' },
    { $set: { engine: 'heuristic' } },
  )

  // Within TTL (100ms), still cached value.
  const v2 = await getTaskEngineConfig('session_summary')
  assert.equal(v2.engine, 'llm')

  // After TTL — fresh read picks up the bypass write.
  await new Promise((r) => setTimeout(r, 150))
  const v3 = await getTaskEngineConfig('session_summary')
  assert.equal(v3.engine, 'heuristic')
})

// ── 10. enabled toggle persists ──────────────────────
test('updateTaskEngineConfig enabled flag round-trip', async () => {
  await updateTaskEngineConfig('chat_assistant', { enabled: false, updatedBy: 'a' })
  const cfg1 = await getTaskEngineConfig('chat_assistant')
  assert.equal(cfg1.enabled, 0)

  await updateTaskEngineConfig('chat_assistant', { enabled: true, updatedBy: 'a' })
  const cfg2 = await getTaskEngineConfig('chat_assistant')
  assert.equal(cfg2.enabled, 1)
})

// ─── S6.1 audit log tests ──────────────────────────────

// ── 11. Update writes one audit row per CHANGED field ──
test('updateTaskEngineConfig appends audit rows for each changed field', async () => {
  // Wipe audit + reset task to a known baseline so we can count diffs
  // independently of earlier tests.
  await TaskEngineAudit.deleteMany({})
  await updateTaskEngineConfig('quality_report_assist', {
    engine: 'heuristic',
    model: null,
    temperature: 0.2,
    updatedBy: 'baseline',
  })
  await TaskEngineAudit.deleteMany({}) // discard baseline diffs

  // Now flip 3 fields in one call.
  await updateTaskEngineConfig('quality_report_assist', {
    engine: 'llm',
    model: 'gpt-4o-mini',
    temperature: 0.7,
    updatedBy: 'admin-99',
  })

  const entries = await getTaskEngineAudit({ taskName: 'quality_report_assist', limit: 50 })
  // engine, model, temperature → 3 rows. provider_id stayed null, etc.
  assert.equal(entries.length, 3)
  const fields = entries.map((e) => e.field).sort()
  assert.deepEqual(fields, ['engine', 'model', 'temperature'])
  for (const e of entries) {
    assert.equal(e.action, 'update')
    assert.equal(e.changed_by, 'admin-99')
  }
  // Spot-check the engine diff carries old + new.
  const engineRow = entries.find((e) => e.field === 'engine')!
  assert.equal(engineRow.old_value, 'heuristic')
  assert.equal(engineRow.new_value, 'llm')
})

// ── 12. Re-saving the same values writes ZERO audit rows
test('updateTaskEngineConfig is silent on no-op edits', async () => {
  await TaskEngineAudit.deleteMany({})
  await updateTaskEngineConfig('anomaly_detection', { engine: 'llm', model: 'm1', updatedBy: 'a' })
  await TaskEngineAudit.deleteMany({}) // clear that initial diff

  // Same values again — nothing should change.
  await updateTaskEngineConfig('anomaly_detection', { engine: 'llm', model: 'm1', updatedBy: 'a' })
  const entries = await getTaskEngineAudit({ taskName: 'anomaly_detection' })
  assert.equal(entries.length, 0, 'no-op save should not write audit rows')
})

// ── 13. Audit query: filter by task + limit cap ────────
test('getTaskEngineAudit filters by taskName and respects limit', async () => {
  await TaskEngineAudit.deleteMany({})
  await updateTaskEngineConfig('token_count', { engine: 'llm', model: 'm1', updatedBy: 'u1' })
  await updateTaskEngineConfig('knowledge_dedup', { engine: 'llm', model: 'm2', updatedBy: 'u2' })

  // Filtered to one task → only its rows
  const filtered = await getTaskEngineAudit({ taskName: 'token_count' })
  assert.ok(filtered.every((e) => e.task_name === 'token_count'))
  assert.ok(filtered.length >= 1)

  // No filter → both tasks present
  const all = await getTaskEngineAudit({ limit: 100 })
  const names = new Set(all.map((e) => e.task_name))
  assert.ok(names.has('token_count'))
  assert.ok(names.has('knowledge_dedup'))

  // Limit caps the row count.
  const small = await getTaskEngineAudit({ limit: 1 })
  assert.equal(small.length, 1)

  // appendTaskEngineAudit (test/reset out-of-band) lands in the same query.
  await appendTaskEngineAudit('token_count', 'test', null, '{"ok":true}', 'test', 'tester-a')
  const withTest = await getTaskEngineAudit({ taskName: 'token_count', limit: 50 })
  const testRow = withTest.find((e) => e.action === 'test')
  assert.ok(testRow, 'appended test row should be returned')
  assert.equal(testRow!.changed_by, 'tester-a')
  assert.equal(testRow!.field, 'test')
})
