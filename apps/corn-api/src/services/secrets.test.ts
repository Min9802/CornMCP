import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  encrypt,
  decrypt,
  isEncrypted,
  maskSecret,
  _resetKeyCacheForTests,
} from './secrets.js'

// ── Test fixture ─────────────────────────────────────────
// Use a deterministic master key per test file run so encrypt/decrypt
// round-trips work without depending on external `.env`. The actual
// production key sourcing is exercised in integration; here we only
// verify the crypto envelope.
process.env['SYSTEM_SETTINGS_MASTER_KEY'] = 'unit-test-master-key-do-not-use-in-prod'
delete process.env['AUTH_JWT_SECRET']
_resetKeyCacheForTests()

// ── 1. Round-trip ─────────────────────────────────────────
test('encrypt → decrypt round-trips arbitrary plaintext', () => {
  const samples = [
    'sk-proj-AVcX4XgmhDcQg',
    '🔑 unicode key with emoji and Việt 🇻🇳',
    'a',
    'x'.repeat(2048), // long key
    '{"json":"payload","with":["array",1,2,3]}',
  ]
  for (const plaintext of samples) {
    const enc = encrypt(plaintext)
    assert.ok(typeof enc === 'string')
    assert.ok(enc!.startsWith('enc:v1:'), `expected enc:v1: prefix for: ${plaintext.slice(0, 20)}`)
    const dec = decrypt(enc)
    assert.equal(dec, plaintext)
  }
})

// ── 2. Idempotency: encrypt(encrypt(x)) === encrypt(x) ────
test('encrypt is idempotent for already-encrypted values', () => {
  const once = encrypt('hello')
  const twice = encrypt(once as string)
  assert.equal(once, twice)
})

// ── 3. Null / undefined / empty passthrough ──────────────
test('null, undefined, and empty string pass through encrypt and decrypt', () => {
  assert.equal(encrypt(null), null)
  assert.equal(encrypt(undefined), undefined)
  assert.equal(encrypt(''), '')
  assert.equal(decrypt(null), null)
  assert.equal(decrypt(undefined), undefined)
  assert.equal(decrypt(''), '')
})

// ── 4. Legacy passthrough: plain text decrypt as-is ──────
test('decrypt returns plain text untouched when prefix missing', () => {
  const legacy = 'plain-text-key-from-old-deploy'
  assert.equal(isEncrypted(legacy), false)
  assert.equal(decrypt(legacy), legacy)
})

// ── 5. Random IV: same plaintext → different ciphertext ───
test('encrypting same plaintext twice yields different ciphertexts', () => {
  const plaintext = 'sk-test-deterministic-input'
  const a = encrypt(plaintext) as string
  const b = encrypt(plaintext) as string
  assert.notEqual(a, b, 'IV reuse would defeat GCM security')
  // Both must still decrypt to the same plaintext
  assert.equal(decrypt(a), plaintext)
  assert.equal(decrypt(b), plaintext)
})

// ── 6. Tamper detection: flipping a ciphertext byte throws ─
test('decrypt throws on tampered ciphertext (GCM auth tag mismatch)', () => {
  const enc = encrypt('important-secret') as string
  // Find the last colon-separated section (ciphertext) and flip a char.
  const parts = enc.slice('enc:v1:'.length).split(':')
  assert.equal(parts.length, 3)
  const ct = parts[2]!
  const flippedChar = ct[0] === 'A' ? 'B' : 'A'
  const tamperedCt = flippedChar + ct.slice(1)
  const tampered = `enc:v1:${parts[0]}:${parts[1]}:${tamperedCt}`
  assert.throws(() => decrypt(tampered), /./, 'tampered ciphertext must throw')
})

// ── 7. Tamper detection: flipping IV throws ──────────────
test('decrypt throws when IV is tampered', () => {
  const enc = encrypt('secret-with-iv-tampered') as string
  const parts = enc.slice('enc:v1:'.length).split(':')
  const iv = parts[0]!
  const flippedChar = iv[0] === 'A' ? 'B' : 'A'
  const tamperedIv = flippedChar + iv.slice(1)
  const tampered = `enc:v1:${tamperedIv}:${parts[1]}:${parts[2]}`
  assert.throws(() => decrypt(tampered), /./, 'tampered IV must throw')
})

// ── 8. Tamper detection: flipping auth tag throws ────────
test('decrypt throws when auth tag is tampered', () => {
  const enc = encrypt('secret-with-tag-tampered') as string
  const parts = enc.slice('enc:v1:'.length).split(':')
  const tag = parts[1]!
  const flippedChar = tag[0] === 'A' ? 'B' : 'A'
  const tamperedTag = flippedChar + tag.slice(1)
  const tampered = `enc:v1:${parts[0]}:${tamperedTag}:${parts[2]}`
  assert.throws(() => decrypt(tampered), /./, 'tampered tag must throw')
})

// ── 9. Malformed envelope ────────────────────────────────
test('decrypt throws on malformed envelope (wrong part count)', () => {
  assert.throws(() => decrypt('enc:v1:onlytwo:parts'), /malformed envelope/)
  assert.throws(() => decrypt('enc:v1:a:b:c:d'), /malformed envelope/)
})

// ── 10. isEncrypted ───────────────────────────────────────
test('isEncrypted recognizes only enc:v1: prefix', () => {
  assert.equal(isEncrypted('enc:v1:foo'), true)
  assert.equal(isEncrypted('enc:v0:foo'), false)
  assert.equal(isEncrypted('plain'), false)
  assert.equal(isEncrypted(''), false)
  assert.equal(isEncrypted(null), false)
  assert.equal(isEncrypted(undefined), false)
})

// ── 11. maskSecret ────────────────────────────────────────
test('maskSecret returns ••••<last4> for plaintext', () => {
  assert.equal(maskSecret('sk-proj-ABCD1234'), '••••1234')
  assert.equal(maskSecret('short'), '••••hort')
  assert.equal(maskSecret('abc'), '••••')          // ≤4 chars: hide length
  assert.equal(maskSecret(''), '')
  assert.equal(maskSecret(null), '')
  assert.equal(maskSecret(undefined), '')
})

test('maskSecret transparently decrypts encrypted values', () => {
  const enc = encrypt('sk-proj-ZZZZ9999') as string
  assert.equal(maskSecret(enc), '••••9999')
})

test('maskSecret returns generic •••• for tampered ciphertext (no leak)', () => {
  const enc = encrypt('any-secret') as string
  const parts = enc.slice('enc:v1:'.length).split(':')
  const ct = parts[2]!
  const tampered = `enc:v1:${parts[0]}:${parts[1]}:${(ct[0] === 'A' ? 'B' : 'A') + ct.slice(1)}`
  assert.equal(maskSecret(tampered), '••••')
})

// ── 12. Master key fallback chain ─────────────────────────
test('decrypt fails after master key changes (no cross-key recovery)', () => {
  process.env['SYSTEM_SETTINGS_MASTER_KEY'] = 'unit-test-master-key-do-not-use-in-prod'
  _resetKeyCacheForTests()
  const enc = encrypt('rotation-test') as string

  // Rotate master key → previous ciphertext must no longer decrypt
  process.env['SYSTEM_SETTINGS_MASTER_KEY'] = 'rotated-master-key-different-value'
  _resetKeyCacheForTests()
  assert.throws(() => decrypt(enc), /./, 'rotated key must not decrypt old ciphertext')

  // Restore for downstream tests in same process
  process.env['SYSTEM_SETTINGS_MASTER_KEY'] = 'unit-test-master-key-do-not-use-in-prod'
  _resetKeyCacheForTests()
})

test('falls back to AUTH_JWT_SECRET when SYSTEM_SETTINGS_MASTER_KEY missing', () => {
  delete process.env['SYSTEM_SETTINGS_MASTER_KEY']
  process.env['AUTH_JWT_SECRET'] = 'fallback-jwt-secret-for-test'
  _resetKeyCacheForTests()

  const enc = encrypt('uses-jwt-fallback') as string
  assert.ok(enc.startsWith('enc:v1:'))
  assert.equal(decrypt(enc), 'uses-jwt-fallback')

  // Restore
  process.env['SYSTEM_SETTINGS_MASTER_KEY'] = 'unit-test-master-key-do-not-use-in-prod'
  _resetKeyCacheForTests()
})

test('throws when neither master key nor AUTH_JWT_SECRET is set', () => {
  delete process.env['SYSTEM_SETTINGS_MASTER_KEY']
  delete process.env['AUTH_JWT_SECRET']
  _resetKeyCacheForTests()
  assert.throws(() => encrypt('anything'), /SYSTEM_SETTINGS_MASTER_KEY/)

  // Restore for downstream tests
  process.env['SYSTEM_SETTINGS_MASTER_KEY'] = 'unit-test-master-key-do-not-use-in-prod'
  _resetKeyCacheForTests()
})
