// ─── System Settings (S2) ────────────────────────────────
// Runtime configuration store backed by `system_settings` (S2.1 migration).
// Priority: DB row > `fallbackEnv` env var > null. Reads cached for 60s
// (overridable via `SYSTEM_SETTINGS_CACHE_TTL_MS`) so admin UI changes
// propagate without a server restart but high-traffic paths don't hammer
// the DB on every call.
//
// Secrets handling:
//   - `is_secret = 1` rows store value wrapped in S1's `enc:v1:` envelope.
//   - `getSetting` transparently decrypts; callers always see plaintext.
//   - `listSettings` returns `••••<last4>` mask via secrets.maskSecret().
//   - Audit entries store the mask too (never raw / never ciphertext)
//     so the history view can be browsed without leaking secrets.
//
// Concurrency:
//   - sql.js is single-process; cache is per-process. Multi-replica
//     deployments need pub/sub or DB poll (deferred to S6+ — current
//     compose file runs a single corn-api container).
//
// Limitations:
//   - Type system stays string-only at the storage layer. Callers cast
//     to number/JSON as needed (e.g. `Number(await getSetting('mail.port'))`).
//   - Hot-reload TTL is best-effort: an in-flight request observed within
//     the cache window after a PATCH still sees the stale value. The
//     setSetting() call invalidates the local cache immediately so
//     subsequent reads in the same process pick up the new value.

import { SystemSetting, SystemSettingAudit } from '../db/mongoose/index.js'
import { encrypt, decrypt, maskSecret } from './secrets.js'

// ── Cache ────────────────────────────────────────────────
interface CacheEntry {
  value: string | null
  expiresAt: number
}
const cache = new Map<string, CacheEntry>()

const DEFAULT_TTL_MS = 60_000
function ttlMs(): number {
  const env = Number(process.env['SYSTEM_SETTINGS_CACHE_TTL_MS'])
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_TTL_MS
}

/** Test-only: clear the in-process cache. Not for production paths. */
export function _clearSettingsCacheForTests(): void {
  cache.clear()
}

// ── Reveal rate limit (S3.3) ─────────────────────────────
// Admin "Reveal secret" flow: we re-expose the plaintext so the admin can
// copy/rotate a key without shelling into a container. Rate-limited so a
// compromised admin session can't dump the secret store in a single sweep.
// In-memory Map per-process; acceptable for single-replica dev. Multi-replica
// hardened deploys should back this with Redis (deferred S6+).
const REVEAL_RATE_LIMIT = 10
const REVEAL_WINDOW_MS = 60 * 60 * 1000
const revealCounters = new Map<string, number[]>()

export function _resetRevealRateLimitForTests(): void {
  revealCounters.clear()
}

export interface RevealCheckResult {
  ok: boolean
  /** Seconds until the oldest entry in the window expires. Present only when ok=false. */
  retryAfterSeconds?: number
  /** How many reveals are still allowed in the current window after this call. */
  remaining: number
}

/**
 * Atomic "record-and-check". Returns ok=false (without recording) once the
 * user has hit `REVEAL_RATE_LIMIT` reveals in the past `REVEAL_WINDOW_MS`.
 * Callers must short-circuit on false — do NOT call `auditReveal()` or return
 * plaintext to the client.
 */
export function checkAndRecordRevealRateLimit(userId: string): RevealCheckResult {
  const now = Date.now()
  const windowStart = now - REVEAL_WINDOW_MS
  const prior = revealCounters.get(userId) ?? []
  const recent = prior.filter((t) => t > windowStart)

  if (recent.length >= REVEAL_RATE_LIMIT) {
    const oldest = recent[0] ?? now
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + REVEAL_WINDOW_MS - now) / 1000))
    // Keep the pruned window so memory doesn't grow with timed-out entries.
    revealCounters.set(userId, recent)
    return { ok: false, retryAfterSeconds, remaining: 0 }
  }

  recent.push(now)
  revealCounters.set(userId, recent)
  return { ok: true, remaining: REVEAL_RATE_LIMIT - recent.length }
}

/**
 * Append a `reveal` audit row. old/new are both NULL — revealing does not
 * change state, we only record *who viewed* the key and when.
 */
export async function auditReveal(key: string, userId: string): Promise<void> {
  // `reveal` is outside the schema enum, but the underlying collection
  // tolerates it (audit reads use string compare). Cast around the strict
  // create signature so we don't widen the enum to admit it everywhere.
  await SystemSettingAudit.create({
    key,
    old_value: null,
    new_value: null,
    action: 'reveal',
    changed_by: userId,
  } as Parameters<typeof SystemSettingAudit.create>[0])
}

// ── Public API ───────────────────────────────────────────

export interface SettingMetadata {
  key: string
  is_secret: 0 | 1
  category: string
  description: string | null
  default_value: string | null
  updated_by: string | null
  updated_at: string
}

export interface SettingRow extends SettingMetadata {
  value_set: boolean
  value_masked: string  // '' if not set; raw value if !is_secret; ••••XXXX if is_secret
}

export interface AuditEntry {
  id: number
  key: string
  old_value: string | null
  new_value: string | null
  action: string
  changed_by: string | null
  changed_at: string
}

export interface SetSettingOpts {
  isSecret?: boolean
  category?: string
  description?: string
  defaultValue?: string
  updatedBy?: string
}

/**
 * Resolve a setting value. Returns DB value (decrypted if secret) when set,
 * else `process.env[fallbackEnv]` if `fallbackEnv` provided, else `null`.
 *
 * Cached per-key for `SYSTEM_SETTINGS_CACHE_TTL_MS` (default 60s). Call
 * `setSetting()` to invalidate on write; concurrent processes are not
 * coordinated — single-replica deployments only.
 */
export async function getSetting(
  key: string,
  fallbackEnv?: string,
): Promise<string | null> {
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expiresAt > now) return hit.value

  let value: string | null = null
  const row = await SystemSetting.findById(key, { value: 1, is_secret: 1 }).lean()
  if (row && row.value !== null && row.value !== '' && row.value !== undefined) {
    const raw: string = row.value
    if (row.is_secret) {
      try {
        const dec = decrypt(raw)
        value = typeof dec === 'string' ? dec : null
      } catch {
        // Tampered/unrecoverable — surface as null so callers fall back to env.
        value = null
      }
    } else {
      value = raw
    }
  }

  if (value === null && fallbackEnv) {
    const envVal = process.env[fallbackEnv]
    value = envVal === undefined || envVal === '' ? null : envVal
  }

  cache.set(key, { value, expiresAt: now + ttlMs() })
  return value
}

/**
 * Upsert a setting. Encrypts value if `is_secret`, appends an audit row,
 * and invalidates the local cache for this key.
 *
 * Pass `null` as `newValue` to clear the override (next read falls back
 * to env or default again).
 */
export async function setSetting(
  key: string,
  newValue: string | null,
  opts: SetSettingOpts = {},
): Promise<void> {
  const existing = await SystemSetting.findById(key, {
    value: 1,
    is_secret: 1,
    category: 1,
    description: 1,
    default_value: 1,
  }).lean()

  // is_secret: explicit > existing > false. Once a key is marked secret the
  // value column is wrapped in `enc:v1:` for any future write.
  const isSecret = opts.isSecret ?? Boolean(existing?.is_secret)

  // Compute encrypted-on-disk new value
  const storedNewValue: string | null =
    newValue === null
      ? null
      : isSecret
      ? (encrypt(newValue) as string)
      : newValue

  // Audit values: mask when secret, raw otherwise.
  const oldRaw = existing?.value ?? null
  const oldForAudit: string | null =
    oldRaw === null ? null : isSecret ? maskSecret(oldRaw) : oldRaw
  const newForAudit: string | null =
    newValue === null
      ? null
      : isSecret
      ? maskSecret(storedNewValue as string)
      : newValue

  // upsert preserves COALESCE(?, existing) semantics: when opts.X is
  // undefined we leave the field alone, otherwise we overwrite.
  const setOps: Record<string, unknown> = {
    value: storedNewValue,
    is_secret: isSecret,
    updated_by: opts.updatedBy ?? 'system',
  }
  if (opts.category !== undefined) setOps['category'] = opts.category
  if (opts.description !== undefined) setOps['description'] = opts.description
  if (opts.defaultValue !== undefined) setOps['default_value'] = opts.defaultValue

  // setOnInsert mirrors INSERT defaults for the brand-new-row path.
  const insertDefaults: Record<string, unknown> = {
    _id: key,
  }
  if (opts.category === undefined) insertDefaults['category'] = 'general'
  if (opts.description === undefined) insertDefaults['description'] = null
  if (opts.defaultValue === undefined) insertDefaults['default_value'] = null

  await SystemSetting.findOneAndUpdate(
    { _id: key },
    { $set: setOps, $setOnInsert: insertDefaults },
    { upsert: true, setDefaultsOnInsert: true },
  )

  await SystemSettingAudit.create({
    key,
    old_value: oldForAudit,
    new_value: newForAudit,
    action: 'set',
    changed_by: opts.updatedBy ?? 'system',
  } as Parameters<typeof SystemSettingAudit.create>[0])

  cache.delete(key)
}

/**
 * List all settings with safe (masked) values. Admin endpoint surface.
 * `category` filter is optional substring-free equality match.
 */
export async function listSettings(
  filter: { category?: string } = {},
): Promise<SettingRow[]> {
  const mongoFilter = filter.category ? { category: filter.category } : {}
  const rows = await SystemSetting.find(mongoFilter, {
    _id: 1,
    value: 1,
    is_secret: 1,
    category: 1,
    description: 1,
    default_value: 1,
    updated_by: 1,
    updated_at: 1,
  })
    .sort({ category: 1, _id: 1 })
    .lean()

  return rows.map((r) => {
    const raw = r.value ?? null
    const isSecret: 0 | 1 = r.is_secret ? 1 : 0
    let valueMasked: string
    if (raw === null || raw === '') {
      valueMasked = ''
    } else if (isSecret === 1) {
      valueMasked = maskSecret(raw)
    } else {
      valueMasked = raw
    }
    return {
      key: r._id,
      is_secret: isSecret,
      category: r.category ?? 'general',
      description: r.description ?? null,
      default_value: r.default_value ?? null,
      updated_by: r.updated_by ?? null,
      // Mongoose returns Date — stringify so the legacy contract holds.
      updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : '',
      value_set: raw !== null && raw !== '',
      value_masked: valueMasked,
    }
  })
}

/**
 * Last `limit` audit entries for a key, newest first. Cap default 50;
 * higher values are accepted but discouraged for unbounded growth.
 *
 * SQL ordered by id DESC; we sort by changed_at DESC instead because
 * the migrated `_id` is Mixed (Number for legacy / ObjectId for new
 * rows) and Mongo can't reliably compare across them.
 */
export async function getSettingAudit(
  key: string,
  limit = 50,
): Promise<AuditEntry[]> {
  const cap = Math.max(1, Math.min(500, limit))
  const rows = await SystemSettingAudit.find(
    { key },
    { _id: 1, key: 1, old_value: 1, new_value: 1, action: 1, changed_by: 1, changed_at: 1 },
  )
    .sort({ changed_at: -1 })
    .limit(cap)
    .lean()

  return rows.map((r) => ({
    // Cast: legacy rows preserved their integer AUTOINCREMENT id, new
    // rows use ObjectId. The public type was `number`; under mongo it's
    // an opaque identifier. Best-effort coerce: number stays number,
    // ObjectId is hashed to a stable number via its timestamp portion
    // so the dashboard can still key off `id`.
    id: typeof r._id === 'number' ? r._id : Math.abs(hashString(String(r._id))),
    key: r.key,
    old_value: r.old_value ?? null,
    new_value: r.new_value ?? null,
    action: r.action ?? 'set',
    changed_by: r.changed_by ?? null,
    changed_at: r.changed_at ? new Date(r.changed_at).toISOString() : '',
  }))
}

/** Stable 32-bit hash of a string (FNV-1a) — used to coerce ObjectId to a number. */
function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// ── Default settings schema + env migration (S3.5) ───────
// Single source of truth for the 17 "runtime knobs" that used to live only
// in `.env`. Ordering is display order for the admin UI (grouped by
// `category`). Each entry MAY supply `envVar` for one-shot migration; keys
// without an envVar are S4 bootstrap-only and get admin-managed defaults.
export interface DefaultSettingSpec {
  key: string
  category: string
  description: string
  isSecret: boolean
  /** When present, `migrateFromEnv` copies `process.env[envVar]` into DB. */
  envVar?: string
  /** Seeded into `default_value` column for UI hints ("Reset to default"). */
  defaultValue?: string
}

export const DEFAULT_SETTINGS: readonly DefaultSettingSpec[] = [
  // Embedding (5)
  // `embedding.provider_id` — when set, overrides the 4 manual fields below by
  // resolving api_key/api_base/model/dims from a configured Provider Account
  // (capabilities=['embedding']). When null, the 4 manual fields stay
  // authoritative — preserves backward compat for existing deployments.
  { key: 'embedding.provider_id', category: 'embedding', description: 'Reference to a Provider Account (capability=embedding). Overrides the manual fields below when set.', isSecret: false },
  { key: 'embedding.api_key', category: 'embedding', description: 'API key for the embedding provider (OpenAI-compatible / Voyage). Ignored when `embedding.provider_id` is set.', isSecret: true, envVar: 'OPENAI_API_KEY' },
  { key: 'embedding.api_base', category: 'embedding', description: 'Base URL for the embedding provider. Ignored when `embedding.provider_id` is set.', isSecret: false, envVar: 'OPENAI_API_BASE', defaultValue: 'https://api.voyageai.com/v1' },
  { key: 'embedding.model', category: 'embedding', description: 'Embedding model identifier (must match provider catalogue). Ignored when `embedding.provider_id` is set.', isSecret: false, envVar: 'MEM9_EMBEDDING_MODEL', defaultValue: 'voyage-code-3' },
  { key: 'embedding.dims', category: 'embedding', description: 'Vector dimensionality — must match the vector store column size. Ignored when `embedding.provider_id` is set.', isSecret: false, envVar: 'MEM9_EMBEDDING_DIMS', defaultValue: '1024' },

  // Mail (8)
  { key: 'mail.host', category: 'mail', description: 'SMTP relay host for OTP + notification emails.', isSecret: false, envVar: 'MAIL_HOST' },
  { key: 'mail.port', category: 'mail', description: 'SMTP port (465 = implicit TLS, 587 = STARTTLS).', isSecret: false, envVar: 'MAIL_PORT', defaultValue: '587' },
  { key: 'mail.username', category: 'mail', description: 'SMTP auth username.', isSecret: false, envVar: 'MAIL_USERNAME' },
  { key: 'mail.password', category: 'mail', description: 'SMTP auth password / app-specific token.', isSecret: true, envVar: 'MAIL_PASSWORD' },
  { key: 'mail.encryption', category: 'mail', description: 'Transport security hint ("tls" / "ssl" / "none").', isSecret: false, envVar: 'MAIL_ENCRYPTION', defaultValue: 'tls' },
  { key: 'mail.from_address', category: 'mail', description: 'Envelope "from" address (must be allowed by the relay).', isSecret: false, envVar: 'MAIL_FROM_ADDRESS' },
  { key: 'mail.from_name', category: 'mail', description: 'Display name shown in the "From" header. `${APP_NAME}` is interpolated.', isSecret: false, envVar: 'MAIL_FROM_NAME', defaultValue: '${APP_NAME}' },
  { key: 'mail.app_name', category: 'mail', description: 'Application name used in email templates / subject lines.', isSecret: false, envVar: 'APP_NAME', defaultValue: 'CornMCP' },

  // Auth (3)
  { key: 'auth.google_client_id', category: 'auth', description: 'Google OAuth 2.0 client ID (admin-linked sign-in).', isSecret: false, envVar: 'GOOGLE_CLIENT_ID' },
  { key: 'auth.google_client_secret', category: 'auth', description: 'Google OAuth 2.0 client secret.', isSecret: true, envVar: 'GOOGLE_CLIENT_SECRET' },
  { key: 'auth.cors_origin', category: 'auth', description: 'Comma-separated list of allowed dashboard origins.', isSecret: false, envVar: 'CORS_ORIGIN', defaultValue: 'http://localhost:3000' },

  // Session (1)
  { key: 'session.auto_close_minutes', category: 'session', description: 'Minutes of inactivity before `active` sessions flip to `abandoned`.', isSecret: false, envVar: 'SESSION_AUTO_CLOSE_MINUTES', defaultValue: '60' },

  // LLM bootstrap (2) — consumed by S4 virtual-provider loader
  { key: 'llm.default_provider_order', category: 'llm', description: 'Comma-separated priority list for the env-fallback virtual provider (S4.10).', isSecret: false, defaultValue: 'openai,gemini,anthropic' },
  { key: 'llm.default_models', category: 'llm', description: 'JSON map `{provider:model}` for env-fallback defaults (S4.10).', isSecret: false, defaultValue: '{"openai":"gpt-4o-mini","gemini":"gemini-1.5-flash","anthropic":"claude-3-5-haiku-20241022"}' },
] as const

export interface MigrateResult {
  /** Keys that were written in this run (new DB rows). */
  migrated: string[]
  /** Keys skipped: either already present, no envVar, or env empty. */
  skipped: { key: string; reason: 'already_set' | 'no_env' | 'env_empty' }[]
}

/**
 * One-shot "seed my DB from the current `.env`" operation. Idempotent:
 * keys with an existing DB row are always skipped so a second invocation
 * (or a partial failure followed by retry) does not clobber admin edits.
 *
 * Security: does NOT log decrypted values. Secret keys are wrapped through
 * `setSetting({isSecret:true})` which stores the `enc:v1:` envelope and
 * audits the mask only.
 */
export async function migrateFromEnv(updatedBy: string): Promise<MigrateResult> {
  const existing = await listSettings()
  const existingKeys = new Set(existing.map((s) => s.key))
  const migrated: string[] = []
  const skipped: MigrateResult['skipped'] = []

  for (const spec of DEFAULT_SETTINGS) {
    if (existingKeys.has(spec.key)) {
      skipped.push({ key: spec.key, reason: 'already_set' })
      continue
    }
    if (!spec.envVar) {
      // LLM bootstrap keys — no env fallback; admin edits in UI.
      skipped.push({ key: spec.key, reason: 'no_env' })
      continue
    }
    const raw = process.env[spec.envVar]
    if (raw === undefined || raw.trim() === '') {
      skipped.push({ key: spec.key, reason: 'env_empty' })
      continue
    }
    await setSetting(spec.key, raw.trim(), {
      isSecret: spec.isSecret,
      category: spec.category,
      description: spec.description,
      defaultValue: spec.defaultValue,
      updatedBy,
    })
    migrated.push(spec.key)
  }

  return { migrated, skipped }
}
