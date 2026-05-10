// ─── LLM Gateway — Cache (S4.1) ─────────────────────────
// In-memory LRU-with-TTL keyed by a SHA-256 of (provider + model +
// messages + temperature + maxTokens). Per-process only; multi-replica
// deploys share nothing here — acceptable for dev single-container,
// S6+ will back this with Redis.
//
// Sizing: cap at 100 entries. A typical response is ≤ a few KB so
// worst-case memory is sub-MB. TTL is per-entry (default 3600s, admin
// can override via `llm.cache_default_ttl_sec`), with `cacheTTLSec=0`
// disabling the cache for a single request entirely.
//
// Cache poisoning mitigation: the key includes temperature and
// maxTokens so different decoding parameters can't cross-contaminate;
// promptTemplate changes also change the messages array, so no
// separate template hash needed.

import { createHash } from 'node:crypto'
import type { ChatRequest, ChatResponse } from './types.js'

export interface CacheEntry {
  response: ChatResponse
  expiresAt: number
}

const MAX_ENTRIES = 100
const store = new Map<string, CacheEntry>()

/** Test-only: clear the cache between cases. */
export function _resetCacheForTests(): void {
  store.clear()
}

/**
 * Build a deterministic cache key from the parts of a request that
 * would change the response. Intentionally excludes `taskName`,
 * `userId`, `sessionId` — those are telemetry, not part of the prompt.
 */
export function buildCacheKey(req: ChatRequest, providerId: string): string {
  const material = JSON.stringify({
    providerId,
    model: req.model,
    messages: req.messages,
    maxTokens: req.maxTokens ?? null,
    temperature: req.temperature ?? null,
  })
  return createHash('sha256').update(material).digest('hex')
}

/** Read a cached response. Returns null when absent or expired. */
export function getCached(key: string): ChatResponse | null {
  const hit = store.get(key)
  if (!hit) return null
  if (hit.expiresAt <= Date.now()) {
    store.delete(key)
    return null
  }
  // Mark as fresh by re-inserting (LRU ordering).
  store.delete(key)
  store.set(key, hit)
  // Return a copy flagged `cached`. Cost is zeroed so callers that
  // aggregate `resp.costUsd` don't double-count already-billed tokens;
  // the original call's cost is already reflected in llm_gateway_logs.
  return { ...hit.response, cached: true, latencyMs: 0, costUsd: 0 }
}

/**
 * Insert or refresh an entry. TTL ≤ 0 is a no-op (admin disabled
 * caching for this call). Evicts the oldest entry when full.
 */
export function setCached(key: string, response: ChatResponse, ttlSec: number): void {
  if (ttlSec <= 0) return
  // LRU eviction: the first entry in Map insertion order is oldest.
  if (store.size >= MAX_ENTRIES && !store.has(key)) {
    const oldestKey = store.keys().next().value
    if (oldestKey !== undefined) store.delete(oldestKey)
  }
  store.set(key, {
    response: { ...response, cached: false },
    expiresAt: Date.now() + ttlSec * 1000,
  })
}

/** Current entry count — useful for tests / debugging. */
export function cacheSize(): number {
  return store.size
}
