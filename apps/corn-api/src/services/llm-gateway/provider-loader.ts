// ─── LLM Gateway — Provider loader (S4.10) ──────────────
// Resolve a concrete {apiKey, apiBase, provider} from either a real
// `provider_accounts` row or, on fresh/empty deployments, a virtual
// provider constructed from `OPENAI_API_KEY` / `GEMINI_API_KEY` /
// `ANTHROPIC_API_KEY` env vars.
//
// Priority order for `resolveProvider(providerId?)`:
//   1. Explicit `providerId` → fetch DB row (enabled only), decrypt.
//   2. Setting `llm.default_provider_id` → same lookup as (1).
//   3. Virtual fallback chain (unless `llm.disable_env_fallback=true`):
//        - Walk `llm.default_provider_order` (CSV, default "openai,
//          gemini,anthropic").
//        - Skip any provider that already has an enabled real row —
//          admin control wins over env.
//        - For each remaining type, if env key exists, build a virtual
//          row `id='env:<provider>'`, log warn once per process.
//   4. None of the above resolve → NoProviderConfiguredError.
//
// Security: env keys are NEVER written back to DB. The virtual row is
// in-memory only; `llm_gateway_logs.provider_id` records `env:*` so
// ops can audit and badge them in UI (S6).

import { ProviderAccount } from '../../db/mongoose/index.js'
import { getSetting } from '../settings.js'
import { decrypt } from '../secrets.js'
import {
  NoProviderConfiguredError,
  type ProviderType,
  type ResolvedProvider,
} from './types.js'

// ── Default API bases ───────────────────────────────────
// Only used for virtual env providers. Real rows supply their own via
// `api_base` column. These match the adapter URL assumptions.
const DEFAULT_API_BASE: Record<ProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
}

// ── Env var mapping for each provider family ────────────
const ENV_KEY_BY_PROVIDER: Record<ProviderType, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
}

// ── One-shot warn tracker ───────────────────────────────
// Module-level state so a long-running process emits exactly one warn
// per provider family even under heavy concurrent load. Reset in tests.
const warnedProviders = new Set<ProviderType>()

export function _resetProviderLoaderForTests(): void {
  warnedProviders.clear()
}

// ── Helpers ─────────────────────────────────────────────

function isProviderType(x: string | null | undefined): x is ProviderType {
  return x === 'openai' || x === 'anthropic' || x === 'gemini'
}

async function fetchRealRow(providerId: string): Promise<ResolvedProvider | null> {
  const row = await ProviderAccount.findOne(
    { _id: providerId, status: 'enabled' },
    { _id: 1, type: 1, api_base: 1, api_key: 1, status: 1 },
  ).lean()
  if (!row) return null

  if (!isProviderType(row.type)) return null

  const storedKey = row.api_key ?? null
  let apiKey = ''
  if (storedKey) {
    const decrypted = decrypt(storedKey)
    apiKey = typeof decrypted === 'string' ? decrypted : ''
  }
  if (!apiKey) return null // Row exists but key is empty — treat as unconfigured.

  return {
    id: row._id,
    provider: row.type,
    apiKey,
    apiBase: row.api_base || DEFAULT_API_BASE[row.type],
    virtual: false,
  }
}

/**
 * Has the admin wired up a real, enabled row for this provider family?
 * Virtual env fallback skips families that have a real row so admin
 * control (rotate/disable) takes precedence.
 */
async function hasEnabledRealRowForType(type: ProviderType): Promise<boolean> {
  const count = await ProviderAccount.countDocuments({ type, status: 'enabled' })
  return count > 0
}

function buildVirtualProvider(type: ProviderType): ResolvedProvider | null {
  const envName = ENV_KEY_BY_PROVIDER[type]
  const apiKey = process.env[envName]
  if (!apiKey || apiKey.trim() === '') return null

  if (!warnedProviders.has(type)) {
    warnedProviders.add(type)
    // eslint-disable-next-line no-console
    console.warn(
      `[llm-gateway] Using env fallback for ${type} (${envName}). ` +
        `Configure a row in provider_accounts via the admin UI for ` +
        `production hardening (key rotation, audit, cost caps).`,
    )
  }

  return {
    id: `env:${type}`,
    provider: type,
    apiKey: apiKey.trim(),
    apiBase: DEFAULT_API_BASE[type],
    virtual: true,
  }
}

async function parseProviderOrder(): Promise<ProviderType[]> {
  const raw = await getSetting('llm.default_provider_order')
  const csv = (raw ?? 'openai,gemini,anthropic').trim()
  const parts = csv
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is ProviderType => isProviderType(s))
  // De-dupe while preserving order.
  return Array.from(new Set(parts))
}

// ── Public API ──────────────────────────────────────────

/**
 * Resolve to a usable provider. Caller passes either:
 *   - `providerId` for a known DB row,
 *   - `provider` to force a specific family through the virtual chain,
 *   - or neither to use settings + chain defaults.
 *
 * Throws {@link NoProviderConfiguredError} when nothing resolves.
 */
export async function resolveProvider(
  opts: { providerId?: string; provider?: ProviderType } = {},
): Promise<ResolvedProvider> {
  // Step 1: explicit providerId wins.
  if (opts.providerId) {
    const real = await fetchRealRow(opts.providerId)
    if (real) return real
    // Explicit id missing / disabled → fall through to chain rather
    // than erroring immediately; gives better UX when an admin
    // temporarily disables a provider.
  }

  // Step 2: setting `llm.default_provider_id` points to a real row.
  const defaultId = await getSetting('llm.default_provider_id')
  if (defaultId) {
    const real = await fetchRealRow(defaultId)
    if (real) return real
  }

  // Step 2b: when caller forced a family (e.g. provider:'openai') prefer
  // any enabled real row of that type over the virtual env fallback.
  // Admin explicit config ALWAYS outranks env defaults, even when no
  // `llm.default_provider_id` was set.
  if (opts.provider) {
    const typeRow = await ProviderAccount.findOne(
      { type: opts.provider, status: 'enabled' },
      { _id: 1 },
    )
      .sort({ created_at: 1 })
      .lean()
    if (typeRow) {
      const real = await fetchRealRow(typeRow._id)
      if (real) return real
    }
  }

  // Step 3: virtual chain (unless disabled).
  const disableRaw = await getSetting('llm.disable_env_fallback')
  const disabled = disableRaw === 'true' || disableRaw === '1'

  // When caller forced a specific provider family, only try that one.
  const order = opts.provider ? [opts.provider] : await parseProviderOrder()

  // Also surface any other enabled real row as a last-ditch before
  // virtual fallback — a user who configured Anthropic but not set
  // `llm.default_provider_id` should still get served.
  if (!opts.provider) {
    const rows = await ProviderAccount.find(
      { status: 'enabled' },
      { _id: 1, type: 1 },
    )
      .sort({ created_at: 1 })
      .lean()
    for (const row of rows) {
      const real = await fetchRealRow(row._id)
      if (real) return real
    }
  }

  if (disabled) {
    throw new NoProviderConfiguredError(
      'No LLM provider configured and llm.disable_env_fallback=true — ' +
        'add a row to provider_accounts via the admin UI.',
    )
  }

  for (const type of order) {
    // Admin row for this family wins — don't create a virtual shadow.
    if (await hasEnabledRealRowForType(type)) continue
    const virtual = buildVirtualProvider(type)
    if (virtual) return virtual
  }

  throw new NoProviderConfiguredError()
}

/**
 * Resolve the default model id for a virtual env provider. Admin can
 * override any value via the `llm.default_models` JSON setting. Hardcoded
 * cost-safe fallbacks used when the setting is missing or malformed.
 */
export async function resolveDefaultModel(type: ProviderType): Promise<string> {
  const raw = await getSetting('llm.default_models')
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object') {
        const value = (parsed as Record<string, unknown>)[type]
        if (typeof value === 'string' && value.trim()) return value.trim()
      }
    } catch {
      // fall through
    }
  }
  const HARDCODED: Record<ProviderType, string> = {
    openai: 'gpt-4o-mini',
    gemini: 'gemini-1.5-flash',
    anthropic: 'claude-3-5-haiku-20241022',
  }
  return HARDCODED[type]
}
