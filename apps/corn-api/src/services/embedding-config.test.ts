// Tests for embedding-config resolver (provider-id vs manual fallback).
// Mirrors the settings.test.ts harness so we share the in-memory Mongo
// replica-set + master-key wiring.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { MongoMemoryReplSet } from 'mongodb-memory-server'

process.env['SYSTEM_SETTINGS_MASTER_KEY'] = 'unit-test-master-key-do-not-use-in-prod'
delete process.env['AUTH_JWT_SECRET']
process.env['SYSTEM_SETTINGS_CACHE_TTL_MS'] = '50'
process.env['DATABASE_DRIVER'] = 'mongo'
// Clear env so manual fallback only fires when we set the DB row.
delete process.env['OPENAI_API_KEY']
delete process.env['OPENAI_API_BASE']
delete process.env['MEM9_EMBEDDING_MODEL']
delete process.env['MEM9_EMBEDDING_DIMS']

const { setupTestMongo, teardownTestMongo } = await import('../test-utils/mongo.js')
const { _resetKeyCacheForTests, encrypt } = await import('./secrets.js')
const { setSetting, _clearSettingsCacheForTests } = await import('./settings.js')
const { resolveEmbeddingConfig } = await import('./embedding-config.js')
const { ProviderAccount } = await import('../db/mongoose/index.js')

_resetKeyCacheForTests()

let replSet: MongoMemoryReplSet

before(async () => {
  replSet = await setupTestMongo()
})

after(async () => {
  await teardownTestMongo(replSet)
})

beforeEach(async () => {
  // Hard reset between tests: drop all settings + providers so each
  // case can declare its own world without leaking state.
  await ProviderAccount.deleteMany({})
  const { SystemSetting } = await import('../db/mongoose/index.js')
  await SystemSetting.deleteMany({})
  _clearSettingsCacheForTests()
})

// ── 1. Manual fallback only — no provider_id ─────────────
test('resolveEmbeddingConfig: manual fallback when provider_id unset', async () => {
  await setSetting('embedding.api_key', 'sk-manual-aaaa', { isSecret: true, category: 'embedding' })
  await setSetting('embedding.api_base', 'https://api.voyageai.com/v1', { category: 'embedding' })
  await setSetting('embedding.model', 'voyage-code-3', { category: 'embedding' })
  await setSetting('embedding.dims', '1024', { category: 'embedding' })
  _clearSettingsCacheForTests()

  const cfg = await resolveEmbeddingConfig()
  assert.equal(cfg.providerId, null)
  assert.equal(cfg.apiKey, 'sk-manual-aaaa')
  assert.equal(cfg.apiBase, 'https://api.voyageai.com/v1')
  assert.equal(cfg.model, 'voyage-code-3')
  assert.equal(cfg.dims, 1024)
})

// ── 2. Provider wins — fully populated provider row ──────
test('resolveEmbeddingConfig: provider_id wins over manual fields when fully populated', async () => {
  // Manual fields = old Voyage config
  await setSetting('embedding.api_key', 'sk-manual-stale', { isSecret: true, category: 'embedding' })
  await setSetting('embedding.api_base', 'https://api.voyageai.com/v1', { category: 'embedding' })
  await setSetting('embedding.model', 'voyage-code-3', { category: 'embedding' })
  await setSetting('embedding.dims', '1024', { category: 'embedding' })

  // Provider = LM Studio
  const storedKey = encrypt('sk-lmstudio-bbbb') as string
  await ProviderAccount.create({
    _id: 'prov-lmstudio',
    name: 'LMstudio',
    type: 'custom',
    auth_type: 'api_key',
    api_base: 'http://192.168.1.17:1234/v1',
    api_key: storedKey,
    api_key_encrypted: true,
    status: 'enabled',
    capabilities: ['embedding'],
    models: ['text-embedding-bge-m3'],
    dims: 1024,
  } as Parameters<typeof ProviderAccount.create>[0])

  await setSetting('embedding.provider_id', 'prov-lmstudio', { category: 'embedding' })
  _clearSettingsCacheForTests()

  const cfg = await resolveEmbeddingConfig()
  assert.equal(cfg.providerId, 'prov-lmstudio')
  assert.equal(cfg.apiKey, 'sk-lmstudio-bbbb', 'decrypted key from provider')
  assert.equal(cfg.apiBase, 'http://192.168.1.17:1234/v1', 'provider api_base wins')
  assert.equal(cfg.model, 'text-embedding-bge-m3', 'provider models[0] wins')
  assert.equal(cfg.dims, 1024)
})

// ── 3. Per-field fallback — provider missing dims ────────
test('resolveEmbeddingConfig: per-field fallback when provider omits dims', async () => {
  await setSetting('embedding.dims', '768', { category: 'embedding' })

  await ProviderAccount.create({
    _id: 'prov-no-dims',
    name: 'PartialProv',
    type: 'custom',
    auth_type: 'api_key',
    api_base: 'http://localhost:9999/v1',
    api_key: null,
    api_key_encrypted: false,
    status: 'enabled',
    capabilities: ['embedding'],
    models: ['some-model'],
    // dims omitted — should fall back to manual 768
  } as Parameters<typeof ProviderAccount.create>[0])

  await setSetting('embedding.provider_id', 'prov-no-dims', { category: 'embedding' })
  _clearSettingsCacheForTests()

  const cfg = await resolveEmbeddingConfig()
  assert.equal(cfg.providerId, 'prov-no-dims')
  assert.equal(cfg.apiBase, 'http://localhost:9999/v1')
  assert.equal(cfg.model, 'some-model')
  assert.equal(cfg.dims, 768, 'manual dims fills the gap')
})

// ── 4. Disabled provider — fallback to manual ────────────
test('resolveEmbeddingConfig: disabled provider falls back to manual fields', async () => {
  await setSetting('embedding.api_base', 'https://manual.example.com/v1', { category: 'embedding' })
  await setSetting('embedding.model', 'manual-model', { category: 'embedding' })
  await setSetting('embedding.dims', '512', { category: 'embedding' })

  await ProviderAccount.create({
    _id: 'prov-disabled',
    name: 'DisabledProv',
    type: 'custom',
    auth_type: 'api_key',
    api_base: 'http://wont-be-used:1234/v1',
    api_key: null,
    api_key_encrypted: false,
    status: 'disabled',
    capabilities: ['embedding'],
    models: ['wont-be-used'],
    dims: 9999,
  } as Parameters<typeof ProviderAccount.create>[0])

  await setSetting('embedding.provider_id', 'prov-disabled', { category: 'embedding' })
  _clearSettingsCacheForTests()

  const cfg = await resolveEmbeddingConfig()
  // providerId is still echoed (admin needs to know what was *intended*)
  // but resolved values come from manual fallback.
  assert.equal(cfg.providerId, 'prov-disabled')
  assert.equal(cfg.apiBase, 'https://manual.example.com/v1')
  assert.equal(cfg.model, 'manual-model')
  assert.equal(cfg.dims, 512)
})

// ── 5. Missing provider — fallback to manual ─────────────
test('resolveEmbeddingConfig: missing provider falls back to manual fields', async () => {
  await setSetting('embedding.api_base', 'https://manual-only.example.com/v1', { category: 'embedding' })
  await setSetting('embedding.provider_id', 'prov-nonexistent', { category: 'embedding' })
  _clearSettingsCacheForTests()

  const cfg = await resolveEmbeddingConfig()
  assert.equal(cfg.providerId, 'prov-nonexistent')
  assert.equal(cfg.apiBase, 'https://manual-only.example.com/v1')
})

// ── 6. Plaintext provider key (legacy unencrypted) ───────
test('resolveEmbeddingConfig: plaintext provider key passes through decrypt() unchanged', async () => {
  await ProviderAccount.create({
    _id: 'prov-plaintext',
    name: 'LegacyPlaintext',
    type: 'custom',
    auth_type: 'api_key',
    api_base: 'http://legacy.example.com/v1',
    api_key: 'plain-key-not-encrypted',
    api_key_encrypted: false,
    status: 'enabled',
    capabilities: ['embedding'],
    models: ['legacy-model'],
    dims: 1024,
  } as Parameters<typeof ProviderAccount.create>[0])

  await setSetting('embedding.provider_id', 'prov-plaintext', { category: 'embedding' })
  _clearSettingsCacheForTests()

  const cfg = await resolveEmbeddingConfig()
  assert.equal(cfg.apiKey, 'plain-key-not-encrypted', 'plaintext key returned as-is')
})
