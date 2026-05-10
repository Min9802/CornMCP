// ─── Secrets layer (S1) ──────────────────────────────────
// AES-256-GCM symmetric encryption for sensitive values stored in DB
// (provider_accounts.api_key, future system_settings.value when is_secret=1).
//
// Format: `enc:v1:<iv-b64>:<tag-b64>:<ciphertext-b64>`
//   - iv  : 12 bytes (GCM standard nonce length)
//   - tag : 16 bytes (GCM auth tag)
//   - ciphertext: arbitrary length, base64
//
// Master key sourcing (priority order):
//   1. process.env.SYSTEM_SETTINGS_MASTER_KEY  (recommended; rotate-able)
//   2. process.env.AUTH_JWT_SECRET             (fallback so existing deploys work)
// Source string is stretched via scryptSync(source, FIXED_SALT, 32) → 256-bit key.
// Salt is fixed (`corn-mcp:secrets:v1`) so the same source always yields the
// same key — required so values encrypted by one process can be decrypted by
// another. Rotating salt = rotating master key = full re-encrypt sweep.
//
// Threat model: protects against `corn.db` exfiltration. Does NOT protect
// against attacker who also has the env var. Master key MUST live outside DB.
//
// Legacy passthrough: any value not starting with `enc:v1:` is returned as-is
// by `decrypt()`. This lets the migration sweep (S1.4) run idempotently and
// avoids breaking deployments mid-rollout.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const PREFIX = 'enc:v1:'
const ALGO = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const SALT = Buffer.from('corn-mcp:secrets:v1', 'utf-8')

let cachedKey: Buffer | null = null
let cachedSource: string | null = null

function resolveSource(): string {
  const explicit = process.env['SYSTEM_SETTINGS_MASTER_KEY']
  if (explicit && explicit.length > 0) return explicit
  const fallback = process.env['AUTH_JWT_SECRET']
  if (fallback && fallback.length > 0) return fallback
  throw new Error(
    'secrets: SYSTEM_SETTINGS_MASTER_KEY (or AUTH_JWT_SECRET fallback) must be set',
  )
}

function getMasterKey(): Buffer {
  const source = resolveSource()
  if (cachedKey && cachedSource === source) return cachedKey
  cachedKey = scryptSync(source, SALT, KEY_BYTES)
  cachedSource = source
  return cachedKey
}

/**
 * Test-only: clear the in-memory key cache so a fresh `process.env` lookup
 * runs on the next call. Production code should never need this.
 */
export function _resetKeyCacheForTests(): void {
  cachedKey = null
  cachedSource = null
}

/** Returns true if the value is in the `enc:v1:` envelope format. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

/**
 * Encrypt a UTF-8 string. Idempotent: a value already in `enc:v1:` form is
 * returned untouched so callers can safely encrypt-on-write without checking.
 * Returns null/undefined unchanged so SQL NULL semantics are preserved.
 */
export function encrypt(plaintext: string | null | undefined): string | null | undefined {
  if (plaintext === null || plaintext === undefined) return plaintext
  if (plaintext === '') return ''
  if (isEncrypted(plaintext)) return plaintext

  const key = getMasterKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
}

/**
 * Decrypt a value previously produced by {@link encrypt}. Legacy passthrough:
 * if the value lacks the `enc:v1:` prefix it's returned as-is so the migration
 * sweep can run incrementally without breaking GET handlers.
 *
 * Throws on tamper (GCM auth tag mismatch) — callers should treat this as a
 * hard error and NOT swallow silently, otherwise tampered keys would surface
 * as "auth failed" upstream and obscure the root cause.
 */
export function decrypt(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return value
  if (value === '') return ''
  if (!isEncrypted(value)) return value

  const body = value.slice(PREFIX.length)
  const parts = body.split(':')
  if (parts.length !== 3) {
    throw new Error('secrets.decrypt: malformed envelope (expected 3 parts)')
  }
  const [ivB64, tagB64, ctB64] = parts as [string, string, string]
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const ciphertext = Buffer.from(ctB64, 'base64')

  if (iv.length !== IV_BYTES) {
    throw new Error(`secrets.decrypt: invalid IV length (got ${iv.length}, expected ${IV_BYTES})`)
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error(`secrets.decrypt: invalid tag length (got ${tag.length}, expected ${TAG_BYTES})`)
  }

  const key = getMasterKey()
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ])
  return plaintext.toString('utf-8')
}

/**
 * Mask a (possibly-encrypted) secret for display: `••••XXXX` showing only the
 * last 4 characters of the *plaintext*. Returns empty string for empty input
 * and `'••••'` if plaintext is shorter than 4 chars (so length isn't leaked).
 *
 * Decrypts first because masking ciphertext would expose IV/tag bytes (which
 * is fine cryptographically but gives attackers no useful surface either).
 */
export function maskSecret(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return ''
  let plaintext: string
  try {
    const decrypted = decrypt(value)
    plaintext = typeof decrypted === 'string' ? decrypted : ''
  } catch {
    // Tampered/unreadable — show generic mask so we don't leak ciphertext.
    return '••••'
  }
  if (plaintext.length === 0) return ''
  if (plaintext.length <= 4) return '••••'
  return `••••${plaintext.slice(-4)}`
}
