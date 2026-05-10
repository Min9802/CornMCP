// ─── LLM Gateway — Public API (S4.3 + S4.7 + S4.9) ──────
// `chatComplete(req)` is the only symbol outer code should import from
// this module. It wires together: cache → provider loader → cost cap
// → adapter dispatch → cost compute → dual log (`llm_gateway_logs` +
// `query_logs`) → cache store.
//
// Fallback chain (S4.7):
//   - Setting `llm.fallback_chain` is a JSON array of provider ids
//     (`["prov-abc", "prov-def"]`). On a primary error (timeout /
//     auth / rate-limit / 5xx — NOT CostCapExceeded, which is global),
//     we walk the chain, logging each attempt as its own
//     `llm_gateway_logs` row with the error filled.
//   - Cost cap throws upward immediately; fallback wouldn't help
//     because the cap is budget-wide, not provider-wide.
//
// query_logs integration (S4.9):
//   - Mirrors successful calls into the existing `query_logs` table as
//     `tool='llm_gateway'` so the cost dashboard can unify display
//     with other tool usage numbers from corn-mcp.
//   - Insert is fire-and-forget (`void`) so LLM latency isn't
//     extended by the second write.

import { LlmGatewayLog, QueryLog } from '../../db/mongoose/index.js'
import { getSetting } from '../settings.js'
import { callOpenAI } from './adapters/openai.js'
import { callAnthropic } from './adapters/anthropic.js'
import { callGemini } from './adapters/gemini.js'
import { buildCacheKey, getCached, setCached } from './cache.js'
import { bumpSpentCache, computeCost, enforceCostCap, estimateTokens } from './cost.js'
import { resolveProvider } from './provider-loader.js'
import {
  CostCapExceededError,
  LLMGatewayError,
  ProviderAuthError,
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  type AdapterRequest,
  type AdapterResponse,
  type ChatRequest,
  type ChatResponse,
  type ProviderType,
  type ResolvedProvider,
} from './types.js'

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_CACHE_TTL_SEC = 3600

// ── Low-level: dispatch to the right adapter ────────────
async function dispatchAdapter(
  provider: ProviderType,
  req: AdapterRequest,
  providerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AdapterResponse> {
  switch (provider) {
    case 'openai':
      return callOpenAI(req, providerId, fetchImpl)
    case 'anthropic':
      return callAnthropic(req, providerId, fetchImpl)
    case 'gemini':
      return callGemini(req, providerId, fetchImpl)
  }
}

// Allow tests to override `fetch` per-call without monkey-patching
// `globalThis`. Production callers never pass this.
export interface ChatCompleteOptions {
  fetchImpl?: typeof fetch
}

async function logGatewayRow(row: {
  taskName: string | null
  providerId: string | null
  provider: string | null
  model: string | null
  inputTokens: number
  outputTokens: number
  costUsd: number
  latencyMs: number
  cached: boolean
  error: string | null
  userId: string | null
  sessionId: string | null
}): Promise<void> {
  await LlmGatewayLog.create({
    task_name: row.taskName,
    provider_id: row.providerId,
    provider: row.provider,
    model: row.model,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cost_usd: row.costUsd,
    latency_ms: row.latencyMs,
    cached: row.cached,
    error: row.error,
    user_id: row.userId,
    session_id: row.sessionId,
  } as Parameters<typeof LlmGatewayLog.create>[0])
}

// Fire-and-forget mirror into `query_logs` so the existing cost
// dashboard (stats.ts, analytics.ts) picks these up without another
// migration. Runs in parallel with the return — caller doesn't wait.
async function logQueryRow(
  req: ChatRequest,
  resp: ChatResponse,
  inputSize: number,
  outputSize: number,
): Promise<void> {
  await QueryLog.create({
    agent_id: req.taskName ?? 'llm_gateway',
    tool: 'llm_gateway',
    project_id: req.sessionId ?? null,
    input_size: inputSize,
    output_size: outputSize,
    compute_tokens: resp.inputTokens + resp.outputTokens,
    compute_model: resp.model,
  } as Parameters<typeof QueryLog.create>[0])
}

async function parseFallbackChain(): Promise<string[]> {
  const raw = await getSetting('llm.fallback_chain')
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    }
  } catch {
    // fall through
  }
  return []
}

/**
 * Does this error indicate we should try the fallback chain?
 * CostCapExceeded is global — fallback wouldn't help. Everything else
 * that's provider-specific (timeout, auth, rate, 5xx) is worth a retry
 * on a different provider.
 */
function shouldFallback(err: unknown): boolean {
  if (err instanceof CostCapExceededError) return false
  return (
    err instanceof ProviderTimeoutError ||
    err instanceof ProviderAuthError ||
    err instanceof ProviderRateLimitError ||
    err instanceof ProviderError
  )
}

// ── Public entry point ──────────────────────────────────

/**
 * Run a chat completion via the first available provider. See module
 * header for the resolution + fallback rules.
 *
 * Callers should `catch (err) { if (err instanceof LLMGatewayError) … }`
 * to cleanly surface gateway-specific errors; unknown throws bubble up.
 */
export async function chatComplete(
  req: ChatRequest,
  opts: ChatCompleteOptions = {},
): Promise<ChatResponse> {
  if (!req.model || req.messages.length === 0) {
    throw new LLMGatewayError('chatComplete requires `model` and at least one message')
  }
  const fetchImpl = opts.fetchImpl ?? fetch

  // 1. Resolve provider (may be virtual env fallback).
  const provider = await resolveProvider({
    providerId: req.providerId,
    provider: req.provider,
  })

  // 2. Cache lookup (pre cost-cap — serving a cached hit never spends).
  const cacheKey = buildCacheKey(req, provider.id)
  const cacheTTL = req.cacheTTLSec ?? (await resolveCacheTTL())
  const hit = cacheTTL > 0 ? getCached(cacheKey) : null
  if (hit) {
    // Record the hit with cost=0 for ratio analytics. Fire-and-forget.
    void logGatewayRow({
      taskName: req.taskName ?? null,
      providerId: provider.id,
      provider: provider.provider,
      model: req.model,
      inputTokens: hit.inputTokens,
      outputTokens: hit.outputTokens,
      costUsd: 0,
      latencyMs: 0,
      cached: true,
      error: null,
      userId: req.userId ?? null,
      sessionId: req.sessionId ?? null,
    }).catch(() => {
      // Swallow — logging must never break the hot path.
    })
    return hit
  }

  // 3. Cost cap — throws CostCapExceededError before any $.
  await enforceCostCap()

  // 4. Try primary, then fallback chain on eligible errors.
  const fallbackChain = req._noFallback ? [] : await parseFallbackChain()
  const attempts = [provider, ...(await resolveChain(fallbackChain))]

  let lastErr: unknown = null
  for (let i = 0; i < attempts.length; i++) {
    const p = attempts[i]!
    try {
      const resp = await runAttempt(p, req, cacheKey, cacheTTL, fetchImpl)
      return resp
    } catch (err) {
      lastErr = err
      // Log the failed attempt so ops can see the chain walk.
      void logGatewayRow({
        taskName: req.taskName ?? null,
        providerId: p.id,
        provider: p.provider,
        model: req.model,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 0,
        cached: false,
        error: (err as Error).message?.slice(0, 500) ?? 'unknown',
        userId: req.userId ?? null,
        sessionId: req.sessionId ?? null,
      }).catch(() => {})

      if (!shouldFallback(err)) throw err
      // Keep walking the chain.
    }
  }
  throw lastErr instanceof Error ? lastErr : new LLMGatewayError('All providers failed')
}

async function runAttempt(
  provider: ResolvedProvider,
  req: ChatRequest,
  cacheKey: string,
  cacheTTL: number,
  fetchImpl: typeof fetch,
): Promise<ChatResponse> {
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const adapterReq: AdapterRequest = {
    apiKey: provider.apiKey,
    apiBase: provider.apiBase,
    model: req.model,
    messages: req.messages,
    maxTokens: req.maxTokens,
    temperature: req.temperature,
    timeoutMs,
  }

  const started = Date.now()
  const result = await dispatchAdapter(provider.provider, adapterReq, provider.id, fetchImpl)
  const latencyMs = Date.now() - started

  // Provider-reported tokens when available; otherwise estimate and
  // flag so downstream cost tallies know to discount.
  let tokensEstimated = false
  let inputTokens = result.inputTokens
  let outputTokens = result.outputTokens
  if (inputTokens === null) {
    inputTokens = estimateTokens(req.messages.map((m) => m.content).join('\n'))
    tokensEstimated = true
  }
  if (outputTokens === null) {
    outputTokens = estimateTokens(result.content)
    tokensEstimated = true
  }

  const costUsd = await computeCost(req.model, inputTokens, outputTokens)
  bumpSpentCache(costUsd)

  const response: ChatResponse = {
    content: result.content,
    inputTokens,
    outputTokens,
    costUsd,
    latencyMs,
    cached: false,
    providerId: provider.id,
    provider: provider.provider,
    model: req.model,
    tokensEstimated,
  }

  // Fire-and-forget logs — never extend the caller's latency.
  void logGatewayRow({
    taskName: req.taskName ?? null,
    providerId: provider.id,
    provider: provider.provider,
    model: req.model,
    inputTokens,
    outputTokens,
    costUsd,
    latencyMs,
    cached: false,
    error: null,
    userId: req.userId ?? null,
    sessionId: req.sessionId ?? null,
  }).catch(() => {})

  const inputSize = req.messages.reduce((acc, m) => acc + m.content.length, 0)
  void logQueryRow(req, response, inputSize, result.content.length).catch(() => {})

  if (cacheTTL > 0) setCached(cacheKey, response, cacheTTL)
  return response
}

async function resolveCacheTTL(): Promise<number> {
  const raw = await getSetting('llm.cache_default_ttl_sec')
  if (!raw) return DEFAULT_CACHE_TTL_SEC
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CACHE_TTL_SEC
}

// For each id in the chain, resolve to a concrete provider row. Unknown
// ids are silently dropped — the chain is best-effort.
async function resolveChain(ids: string[]): Promise<ResolvedProvider[]> {
  const out: ResolvedProvider[] = []
  for (const id of ids) {
    try {
      const p = await resolveProvider({ providerId: id })
      // Skip dupes of the primary (resolveProvider may have returned a
      // virtual fallback again for an unknown id).
      if (!out.some((x) => x.id === p.id)) out.push(p)
    } catch {
      // Unknown id — skip.
    }
  }
  return out
}

// ── Re-exports for callers ──────────────────────────────
export type {
  ChatRequest,
  ChatResponse,
  Message,
  ProviderType,
} from './types.js'
export {
  LLMGatewayError,
  CostCapExceededError,
  NoProviderConfiguredError,
  ProviderTimeoutError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderError,
} from './types.js'
