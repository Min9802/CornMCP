// Settings layer (S2) integration tests. Uses a real sql.js DB on a temp
// file so we exercise the migration runner + schema.sql for free, the same
// path used in production. Each test re-points DATABASE_PATH to a fresh
// file via dynamic import + module cache reset.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Env wiring must happen before any DB/secrets module is imported so the
// dynamic `await import` calls below see the right DATABASE_PATH and master
// key. We can't use `before()` for that — node:test runs `before` AFTER the
// top-level module body has finished evaluating.
const tmpDir = mkdtempSync(join(tmpdir(), 'corn-settings-test-'))
process.env['DATABASE_PATH'] = join(tmpDir, 'test.db')
process.env['SYSTEM_SETTINGS_MASTER_KEY'] = 'unit-test-master-key-do-not-use-in-prod'
delete process.env['AUTH_JWT_SECRET']
// Short TTL so cache tests don't have to wait 60s.
process.env['SYSTEM_SETTINGS_CACHE_TTL_MS'] = '100'

// Import after env is wired so the modules pick up our DATABASE_PATH.
const { _resetKeyCacheForTests } = await import('./secrets.js')
const {
  getSetting,
  setSetting,
  listSettings,
  getSettingAudit,
  _clearSettingsCacheForTests,
  _resetRevealRateLimitForTests,
  checkAndRecordRevealRateLimit,
  auditReveal,
  migrateFromEnv,
  DEFAULT_SETTINGS,
} = await import('./settings.js')
const { closeDb, flushDb } = await import('../db/client.js')

_resetKeyCacheForTests()

// Single teardown — order is critical:
//   1. drain the debounced async writer so no `writeFile` is mid-flight
//   2. close the DB (sets internal db=null, stopping any future write loop)
//   3. yield one tick so any setImmediate/setTimeout(250) backoff that was
//      already scheduled gets a chance to no-op against the closed DB
//   4. only THEN delete the tmpdir — otherwise the writer would ENOENT-loop
after(async () => {
  try { await flushDb() } catch { /* best effort */ }
  try { closeDb() } catch { /* best effort */ }
  await new Promise((r) => setTimeout(r, 50))
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

// `before()` hook is intentionally absent — env was wired at module top so
// the dynamic imports above already saw it. Keeping the import so node:test
// recognizes this is a test file even if a future refactor adds setup back.
void before

// ── 1. Round-trip: plain value ────────────────────────────
test('setSetting / getSetting round-trip — plain value', async () => {
  await setSetting('test.plain', 'hello-world', { category: 'test' })
  _clearSettingsCacheForTests()
  const value = await getSetting('test.plain')
  assert.equal(value, 'hello-world')
})

// ── 2. Round-trip: secret value (encrypted on disk) ──────
test('setSetting / getSetting round-trip — secret value (encrypted at rest)', async () => {
  const plaintext = 'sk-supersecret-12345678'
  await setSetting('test.secret', plaintext, { isSecret: true, category: 'test' })
  _clearSettingsCacheForTests()

  // Plaintext returned to the caller
  const value = await getSetting('test.secret')
  assert.equal(value, plaintext)

  // On-disk should be encrypted (envelope prefix)
  const list = await listSettings()
  const meta = list.find((s) => s.key === 'test.secret')
  assert.ok(meta, 'setting should be present in list')
  assert.equal(meta!.is_secret, 1)
  assert.equal(meta!.value_masked, '••••5678')
})

// ── 3. Env fallback when DB row absent ───────────────────
test('getSetting falls back to fallbackEnv when DB has no row', async () => {
  process.env['CORN_TEST_FALLBACK'] = 'from-env'
  _clearSettingsCacheForTests()
  const value = await getSetting('test.no_db_row', 'CORN_TEST_FALLBACK')
  assert.equal(value, 'from-env')
})

// ── 4. Empty env fallback returns null (not '') ─────────
test('getSetting returns null when neither DB nor env provide a value', async () => {
  delete process.env['CORN_TEST_MISSING']
  _clearSettingsCacheForTests()
  const value = await getSetting('test.missing', 'CORN_TEST_MISSING')
  assert.equal(value, null)
})

// ── 5. DB takes priority over env ────────────────────────
test('DB row wins over env fallback', async () => {
  process.env['CORN_TEST_PRIORITY'] = 'env-value'
  await setSetting('test.priority', 'db-value', { category: 'test' })
  _clearSettingsCacheForTests()
  const value = await getSetting('test.priority', 'CORN_TEST_PRIORITY')
  assert.equal(value, 'db-value')
})

// ── 6. Cache: read returns stale until TTL expires ───────
test('getSetting cache holds a value within TTL', async () => {
  await setSetting('test.cached', 'first', { category: 'test' })
  _clearSettingsCacheForTests()
  const v1 = await getSetting('test.cached')
  assert.equal(v1, 'first')

  // Bypass setSetting to simulate an out-of-band write that the cache
  // shouldn't yet observe (e.g. a sibling process update).
  const { dbRun } = await import('../db/client.js')
  await dbRun(
    `UPDATE system_settings SET value = ?, updated_at = datetime('now') WHERE key = ?`,
    ['second', 'test.cached'],
  )
  const v2 = await getSetting('test.cached')
  assert.equal(v2, 'first', 'value should be cached for TTL window')

  // After TTL (we set 100ms in before())
  await new Promise((r) => setTimeout(r, 150))
  const v3 = await getSetting('test.cached')
  assert.equal(v3, 'second', 'cache should expire and re-read DB')
})

// ── 7. setSetting invalidates cache immediately ──────────
test('setSetting invalidates cache so next getSetting sees fresh value', async () => {
  await setSetting('test.invalidate', 'before', { category: 'test' })
  _clearSettingsCacheForTests()
  await getSetting('test.invalidate')  // populate cache
  await setSetting('test.invalidate', 'after')  // should invalidate
  const value = await getSetting('test.invalidate')
  assert.equal(value, 'after')
})

// ── 8. Audit: write logs old + new ───────────────────────
test('setSetting appends audit row with old + new values', async () => {
  await setSetting('test.audit', 'v1', { category: 'test', updatedBy: 'user-1' })
  await setSetting('test.audit', 'v2', { updatedBy: 'user-2' })

  const audit = await getSettingAudit('test.audit')
  assert.ok(audit.length >= 2, 'expected at least 2 audit rows')
  // Newest first
  const latest = audit[0]!
  assert.equal(latest.key, 'test.audit')
  assert.equal(latest.old_value, 'v1')
  assert.equal(latest.new_value, 'v2')
  assert.equal(latest.changed_by, 'user-2')
  assert.equal(latest.action, 'set')
})

// ── 9. Audit: secrets stored as masks (no raw, no ciphertext) ──
test('audit stores ••••<last4> for secrets, never raw or ciphertext', async () => {
  await setSetting('test.secret_audit', 'sk-aaaa1111', { isSecret: true, category: 'test', updatedBy: 'u1' })
  await setSetting('test.secret_audit', 'sk-bbbb2222', { updatedBy: 'u2' })

  const audit = await getSettingAudit('test.secret_audit')
  const latest = audit[0]!
  // old must be masked (not raw, not enc:v1:)
  assert.equal(latest.old_value, '••••1111')
  // new must also be masked
  assert.equal(latest.new_value, '••••2222')
  // Belt-and-suspenders: no envelope leak
  assert.ok(!String(latest.old_value).startsWith('enc:v1:'))
  assert.ok(!String(latest.new_value).startsWith('enc:v1:'))
})

// ── 10. listSettings — secrets masked, plain raw ─────────
test('listSettings masks secrets but exposes plain values', async () => {
  await setSetting('test.list_plain', 'public-info', { category: 'test' })
  await setSetting('test.list_secret', 'top-secret-9999', { isSecret: true, category: 'test' })
  _clearSettingsCacheForTests()

  const list = await listSettings({ category: 'test' })
  const plain = list.find((s) => s.key === 'test.list_plain')!
  const secret = list.find((s) => s.key === 'test.list_secret')!

  assert.equal(plain.is_secret, 0)
  assert.equal(plain.value_masked, 'public-info')

  assert.equal(secret.is_secret, 1)
  assert.equal(secret.value_masked, '••••9999')
})

// ── 11. Setting null clears the override ─────────────────
test('setting value=null clears the row value (next read falls back)', async () => {
  await setSetting('test.clear', 'set', { category: 'test' })
  await setSetting('test.clear', null)
  _clearSettingsCacheForTests()

  process.env['CORN_TEST_CLEAR_FB'] = 'env-restored'
  const value = await getSetting('test.clear', 'CORN_TEST_CLEAR_FB')
  assert.equal(value, 'env-restored', 'cleared row should fall through to env')
})

// ── 12. Secret toggle: plain → secret on next set ────────
test('flipping is_secret encrypts subsequent writes', async () => {
  await setSetting('test.toggle', 'plain-text', { category: 'test' })
  // Promote to secret
  await setSetting('test.toggle', 'now-encrypted-7777', { isSecret: true })

  const list = await listSettings({ category: 'test' })
  const meta = list.find((s) => s.key === 'test.toggle')!
  assert.equal(meta.is_secret, 1)
  assert.equal(meta.value_masked, '••••7777')
})

// ── 13. Audit limit enforced ──────────────────────────────
test('getSettingAudit honours limit', async () => {
  for (let i = 0; i < 5; i++) {
    await setSetting('test.limit', String(i), { category: 'test' })
  }
  const limited = await getSettingAudit('test.limit', 2)
  assert.equal(limited.length, 2)
  // Ordered newest first
  assert.equal(limited[0]!.new_value, '4')
  assert.equal(limited[1]!.new_value, '3')
})

// ── 14. Reveal rate limit — 11th call fails, first 10 succeed ─
test('checkAndRecordRevealRateLimit caps at 10 calls per hour per user', () => {
  _resetRevealRateLimitForTests()
  const userId = 'test-user-rl'

  for (let i = 0; i < 10; i++) {
    const r = checkAndRecordRevealRateLimit(userId)
    assert.equal(r.ok, true, `call #${i + 1} should succeed`)
    assert.equal(r.remaining, 10 - (i + 1))
  }

  // 11th attempt — blocked
  const blocked = checkAndRecordRevealRateLimit(userId)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.remaining, 0)
  assert.ok(
    typeof blocked.retryAfterSeconds === 'number' && blocked.retryAfterSeconds > 0,
    'should include retry_after seconds',
  )

  // Different user isolated
  const other = checkAndRecordRevealRateLimit('other-user')
  assert.equal(other.ok, true)
})

// ── 15. Reveal writes an audit row (old/new null, action=reveal) ──
test('auditReveal appends a reveal row that does not leak plaintext', async () => {
  await setSetting('test.reveal_audit', 'sk-reveal-9999', {
    isSecret: true,
    category: 'test',
    updatedBy: 'seeder',
  })

  // Clear set-audit rows from the assertion window by scoping to this key
  const before = await getSettingAudit('test.reveal_audit')

  await auditReveal('test.reveal_audit', 'admin-xyz')

  const after = await getSettingAudit('test.reveal_audit')
  assert.equal(after.length, before.length + 1, 'exactly one reveal row appended')
  const newest = after[0]!
  assert.equal(newest.action, 'reveal')
  assert.equal(newest.old_value, null, 'reveal never records a value')
  assert.equal(newest.new_value, null, 'reveal never records a value')
  assert.equal(newest.changed_by, 'admin-xyz')
})

// ── 16. migrateFromEnv — idempotent + respects envVar presence ────
test('migrateFromEnv seeds missing keys from env and skips present rows on re-run', async () => {
  // Build a disjoint env surface so we don't collide with earlier tests
  process.env['OPENAI_API_KEY'] = 'sk-embed-key-aaaa'
  process.env['OPENAI_API_BASE'] = 'https://api.voyageai.com/v1'
  process.env['MEM9_EMBEDDING_MODEL'] = 'voyage-code-3'
  // Intentionally leave MEM9_EMBEDDING_DIMS unset → should skip as env_empty
  delete process.env['MEM9_EMBEDDING_DIMS']

  // First run
  _clearSettingsCacheForTests()
  const r1 = await migrateFromEnv('admin-migrator')
  const migratedKeys = new Set(r1.migrated)
  assert.ok(migratedKeys.has('embedding.api_key'), 'embedding.api_key migrated')
  assert.ok(migratedKeys.has('embedding.api_base'), 'embedding.api_base migrated')
  assert.ok(migratedKeys.has('embedding.model'), 'embedding.model migrated')

  const skippedByReason = r1.skipped.reduce<Record<string, string[]>>((acc, s) => {
    ;(acc[s.reason] ??= []).push(s.key)
    return acc
  }, {})
  assert.ok(
    (skippedByReason['env_empty'] ?? []).includes('embedding.dims'),
    'embedding.dims skipped because env was empty',
  )
  assert.ok(
    (skippedByReason['no_env'] ?? []).includes('llm.default_provider_order'),
    'llm.default_provider_order has no envVar → no_env',
  )

  // Secret was stored encrypted (mask visible via listSettings)
  const list = await listSettings({ category: 'embedding' })
  const apiKey = list.find((s) => s.key === 'embedding.api_key')!
  assert.equal(apiKey.is_secret, 1)
  assert.equal(apiKey.value_masked, '••••aaaa')

  // Second run — all previously-migrated keys now fall into `already_set`
  const r2 = await migrateFromEnv('admin-migrator')
  assert.equal(r2.migrated.length, 0, 'no new migrations on second run')
  const alreadySet = new Set(
    r2.skipped.filter((s) => s.reason === 'already_set').map((s) => s.key),
  )
  assert.ok(alreadySet.has('embedding.api_key'))
  assert.ok(alreadySet.has('embedding.api_base'))

  // Sanity: schema shape matches what the UI expects.
  // 18 = embedding (4) + mail (8) + auth (3) + session (1) + llm bootstrap (2).
  // Note: PROJECT_CONTEXT + plan both quoted "17" originally which is the
  // pre-llm-bootstrap count; the llm.* keys bumped the total to 18 after
  // the S4.10 design update.
  assert.equal(DEFAULT_SETTINGS.length, 18, 'schema pins 18 default keys')
})
