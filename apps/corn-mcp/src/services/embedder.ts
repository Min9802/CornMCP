// ─── Embedding Provider Bootstrap ────────────────────────
// Single source of truth for how `corn_memory_*` and `corn_knowledge_*`
// construct their embedder. Previously each tool duplicated env reads
// + hardcoded defaults (`voyage-code-3`, `voyage-3-large`, …); now the
// 4 primary fields (api_key, api_base, model, dims) come from the
// corn-api system_settings table via /api/system/embedding-config so
// the admin UI can swap providers (e.g. Voyage → LM Studio bge-m3)
// without touching .env or rebuilding the container.
//
// Priority per field:
//   1. corn-api system_settings DB row (admin-managed via UI)
//   2. process.env (.env / docker-compose env_file fallback)
//   3. provider-agnostic default (voyage-code-3 / 1024-dim) — last resort
//      so a brand-new clone with neither DB nor env keeps Mem9 online.
//
// Fallback model rotation list (`MEM9_FALLBACK_MODELS`) intentionally
// stays env-only: it's a 429-recovery knob, not a steady-state config,
// so propagation latency from admin UI is not worth the schema churn.
//
// Cache: 60s in-process per-MCP. Mirrors task-dispatcher cadence so
// admin edits surface within the same window everywhere.

import type { McpEnv } from '@corn/shared-types'
import {
  Mem9Service,
  OpenAIEmbeddingProvider,
  LocalHashEmbeddingProvider,
} from '@corn/shared-mem9'
import type { EmbeddingProvider } from '@corn/shared-mem9'

export interface EmbeddingConfig {
  apiKey: string | null
  apiBase: string | null
  model: string | null
  dims: number | null
}

interface ResolvedEmbeddingConfig {
  apiKey: string
  apiBase: string
  model: string
  dims: number
  fallbackModels: string[]
  /** Where each field ultimately came from — useful for /health diagnostics. */
  source: 'db' | 'env' | 'default'
}

// ── Cache (per-process, 60s) ─────────────────────────────
const DEFAULT_TTL_MS = 60_000
function cacheTtlMs(): number {
  const env = Number(process.env['EMBEDDING_CONFIG_CACHE_TTL_MS'])
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_TTL_MS
}

interface CacheEntry {
  config: EmbeddingConfig
  expiresAt: number
  /** Whether the value came from the corn-api round-trip (true) or an env fallback (false). */
  fromApi: boolean
}
let cache: CacheEntry | null = null

export function _clearEmbeddingConfigCacheForTests(): void {
  cache = null
}

// ── HTTP injection seam (test hook) ─────────────────────
let fetchImpl: typeof fetch = fetch
export function _setFetchImplForTests(impl: typeof fetch): void {
  fetchImpl = impl
}
export function _resetFetchImplForTests(): void {
  fetchImpl = fetch
}

function apiBaseUrl(env: McpEnv): string {
  return (env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')
}

function authHeaders(env: McpEnv): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.DASHBOARD_API_KEY) h['X-API-Key'] = env.DASHBOARD_API_KEY
  return h
}

/**
 * Fetch the live embedding config from corn-api. Result cached
 * per-process for ~60s. On fetch error returns an env-derived config
 * so cold-start still works when corn-api is briefly unreachable
 * (matches task-dispatcher's "stay online" policy).
 *
 * Never logs the response body — `apiKey` is plaintext after server-
 * side decrypt and must not leak into stdout/stderr or telemetry.
 */
export async function fetchEmbeddingConfig(env: McpEnv): Promise<EmbeddingConfig> {
  const now = Date.now()
  if (cache && cache.expiresAt > now) return cache.config

  let config: EmbeddingConfig
  let fromApi = false
  try {
    const url = `${apiBaseUrl(env)}/api/system/embedding-config`
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: authHeaders(env),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      throw new Error(`embedding-config HTTP ${res.status}`)
    }
    const body = (await res.json()) as Partial<EmbeddingConfig>
    config = {
      apiKey: body.apiKey ?? null,
      apiBase: body.apiBase ?? null,
      model: body.model ?? null,
      dims: typeof body.dims === 'number' && body.dims > 0 ? body.dims : null,
    }
    fromApi = true
  } catch (err) {
    // Stay online with env-only fallback. Log at warn — cold-start
    // when corn-api is still booting is common in compose.
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[corn-mcp] fetchEmbeddingConfig fell back to env: ${msg}`)
    config = readConfigFromEnv()
  }

  cache = { config, expiresAt: now + cacheTtlMs(), fromApi }
  return config
}

/** Pure env read — no HTTP. Used as fallback when corn-api is down. */
function readConfigFromEnv(): EmbeddingConfig {
  const apiKey = process.env['OPENAI_API_KEY'] || null
  const apiBase = process.env['OPENAI_API_BASE'] || null
  const model = process.env['MEM9_EMBEDDING_MODEL'] || null
  const dimsRaw = Number(process.env['MEM9_EMBEDDING_DIMS'])
  return {
    apiKey,
    apiBase,
    model,
    dims: Number.isFinite(dimsRaw) && dimsRaw > 0 ? dimsRaw : null,
  }
}

/**
 * Final config consumed by the embedder constructor. Fills any null
 * field from env (already considered by corn-api but defended again
 * here in case the DB row exists but holds null) and then from
 * provider-agnostic defaults so the embedder always has 4 non-null
 * fields to work with.
 */
function resolveConfig(config: EmbeddingConfig): ResolvedEmbeddingConfig {
  const envFallback = readConfigFromEnv()

  // Track origin per-field so /health can show "db" / "env" / "default".
  // Aggregate to the lowest-confidence source for the response label.
  const tier = { db: 0, env: 1, default: 2 } as const
  let worstTier: keyof typeof tier = 'db'
  function pick<T>(primary: T | null, env: T | null, fallback: T): T {
    if (primary !== null && primary !== undefined) return primary
    if (env !== null && env !== undefined) {
      if (tier[worstTier] < tier.env) worstTier = 'env'
      return env
    }
    if (tier[worstTier] < tier.default) worstTier = 'default'
    return fallback
  }

  const apiKey = pick(config.apiKey, envFallback.apiKey, '')
  const apiBase = pick(config.apiBase, envFallback.apiBase, 'https://api.voyageai.com/v1')
  const model = pick(config.model, envFallback.model, 'voyage-code-3')
  const dims = pick(config.dims, envFallback.dims, 1024)

  // ⚠ Fallback model list MUST output the same dimension as `dims`
  // (Qdrant collection size). Mismatched fallbacks surface as
  // "Wrong input: Vector dimension error" on every search/store —
  // the embedder asserts dim post-call to fail-fast with a clearer
  // message. Pre-2026-05-12 commits had hardcoded voyage-3-* here;
  // intentionally removed so admin-swapped models (e.g. bge-m3) don't
  // silently rotate back to a Voyage call that can't auth on a
  // LM Studio endpoint.
  const fallbackEnv = process.env['MEM9_FALLBACK_MODELS'] || ''
  const fallbackModels = fallbackEnv
    ? fallbackEnv
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
    : []

  return { apiKey, apiBase, model, dims, fallbackModels, source: worstTier }
}

/**
 * Build the embedder. When no api_key is configured anywhere we drop
 * to `LocalHashEmbeddingProvider` so single-binary deployments without
 * a Voyage / LM Studio reachable still get *something* searchable
 * (poor quality, but better than a hard failure on Mem9.init()).
 *
 * Caller owns the lifecycle: typically called once per MCP cold start
 * via `getMem9(env)` in memory.ts / knowledge.ts.
 */
export async function createEmbedder(env: McpEnv): Promise<EmbeddingProvider> {
  const remote = await fetchEmbeddingConfig(env)
  const cfg = resolveConfig(remote)

  if (!cfg.apiKey) {
    console.error(
      '[corn-mcp] No embedding api_key in system_settings or env — using local hash embeddings (low-quality fallback)',
    )
    return new LocalHashEmbeddingProvider(256)
  }

  try {
    const embedder = new OpenAIEmbeddingProvider(
      cfg.apiKey,
      cfg.apiBase,
      cfg.model,
      cfg.dims,
      cfg.fallbackModels,
    )
    await embedder.embed(['test'])
    const fallbacksLabel =
      cfg.fallbackModels.length > 0 ? cfg.fallbackModels.join(', ') : '(none)'
    console.error(
      `[corn-mcp] Embedding validated ✓ source=${cfg.source} model=${cfg.model} dims=${cfg.dims} base=${cfg.apiBase} fallbacks=${fallbacksLabel}`,
    )
    return embedder
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(
      `[corn-mcp] Embedding validation failed (model=${cfg.model} base=${cfg.apiBase}): ${msg} — falling back to local hash`,
    )
    return new LocalHashEmbeddingProvider(256)
  }
}

// ── Shared Mem9 singleton ────────────────────────────────
// memory.ts and knowledge.ts both want the *same* Mem9Service instance
// (single embedder, single Qdrant client, single ensureCollection
// round-trip). Previously each tool maintained its own `let mem9 =
// null` which double-initialised the embedder on cold start.

let mem9: Mem9Service | null = null
let initPromise: Promise<Mem9Service> | null = null

export function _resetMem9ForTests(): void {
  mem9 = null
  initPromise = null
}

export function getMem9(env: McpEnv): Promise<Mem9Service> {
  if (mem9) return Promise.resolve(mem9)
  if (!initPromise) {
    initPromise = createEmbedder(env).then(async (embedder) => {
      const qdrantUrl = env.QDRANT_URL || process.env['QDRANT_URL'] || 'http://localhost:6333'
      const svc = new Mem9Service(qdrantUrl, embedder)
      // ensureCollection is idempotent (probes GET /collections/:name
      // first), so this is safe on every cold start.
      await svc.init()
      mem9 = svc
      return svc
    })
  }
  return initPromise
}

export interface EmbeddingProbeResult {
  status: 'ok' | 'unconfigured' | 'invalid_key' | 'unreachable'
  model: string
  apiBase: string
  dims: number
  source: 'db' | 'env' | 'default'
  apiKeySet: boolean
  apiKeyMasked: string
  fallbackModels: string[]
  /** Populated when status !== 'ok'. Never contains the apiKey. */
  error?: string
}

/**
 * Diagnostic for /health: resolves the current config and (if an
 * apiKey is present) runs a 1-token embed against the configured
 * provider so the admin can verify end-to-end reachability + auth.
 *
 * NEVER includes the apiKey in the returned object — only a
 * `••••XXXX` mask. Errors stringify the HTTP status / network
 * message and are sanitised by the provider already; defending
 * a second time would require deep inspection.
 */
export async function probeEmbeddingHealth(env: McpEnv): Promise<EmbeddingProbeResult> {
  const remote = await fetchEmbeddingConfig(env)
  const cfg = resolveConfig(remote)
  const last4 = cfg.apiKey.length >= 4 ? cfg.apiKey.slice(-4) : ''
  const base = {
    model: cfg.model,
    apiBase: cfg.apiBase,
    dims: cfg.dims,
    source: cfg.source,
    apiKeySet: Boolean(cfg.apiKey),
    apiKeyMasked: cfg.apiKey ? `••••${last4}` : '',
    fallbackModels: cfg.fallbackModels,
  }

  if (!cfg.apiKey || cfg.apiKey === 'proxy-key') {
    return { ...base, status: 'unconfigured' }
  }

  try {
    const url = `${cfg.apiBase.replace(/\/$/, '')}/embeddings`
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ input: ['test'], model: cfg.model }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      return { ...base, status: 'invalid_key', error: `HTTP ${res.status}` }
    }
    return { ...base, status: 'ok' }
  } catch (err) {
    return {
      ...base,
      status: 'unreachable',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
