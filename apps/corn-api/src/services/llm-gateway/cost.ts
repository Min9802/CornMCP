// ─── LLM Gateway — Cost (S4.4 + S4.6) ───────────────────
// Compute per-call cost from token counts + enforce a daily USD cap so
// a runaway loop can't spend the whole budget in one night.
//
// Pricing sourced from provider public pricing pages (2025-05). Admins
// can override any row at runtime via setting `llm.pricing.<model>`
// JSON `{"input": 0.15, "output": 0.6}` (USD per 1M tokens) without
// redeploying. Defaults are seed-only — we log a console.warn if a
// model shows up without pricing so the operator can add an override.
//
// Cost cap:
//   - Setting `llm.cost_cap_usd_per_day` (default "1.0").
//   - Queries `SELECT SUM(cost_usd) FROM llm_gateway_logs WHERE error IS NULL
//     AND created_at >= datetime('now','-1 day')`.
//   - Result cached 60s to avoid hot-path DB reads.
//   - Race: concurrent callers can each see the same pre-bump sum and
//     collectively over-spend by at most (maxConcurrent * maxCostPerCall).
//     For cap=$1/day that's ~$0.05 overrun — acceptable. Document in risk R2.

import { dbGet } from '../../db/client.js'
import { getSetting } from '../settings.js'
import { CostCapExceededError } from './types.js'
import type { ProviderType } from './types.js'

/**
 * Seed pricing table (USD per 1M tokens). Runtime override via
 * `llm.pricing.<model>` setting wins. Keys are exact model ids the
 * adapters forward to the provider (case-sensitive).
 */
export const DEFAULT_PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI — https://openai.com/api/pricing/
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'o1-mini': { input: 3, output: 12 },
  'o3-mini': { input: 1.1, output: 4.4 },

  // Anthropic — https://www.anthropic.com/pricing
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4 },
  'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
  'claude-3-7-sonnet-20250219': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },

  // Google — https://ai.google.dev/pricing
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
}

export interface PricingRow {
  input: number
  output: number
}

/**
 * Look up pricing for a model. Order: admin override setting
 * `llm.pricing.<model>` → `DEFAULT_PRICING` → null (with warn).
 * Returns USD per 1M tokens.
 */
export async function getPricing(model: string): Promise<PricingRow | null> {
  const override = await getSetting(`llm.pricing.${model}`)
  if (override) {
    try {
      const parsed = JSON.parse(override) as unknown
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as PricingRow).input === 'number' &&
        typeof (parsed as PricingRow).output === 'number'
      ) {
        return parsed as PricingRow
      }
    } catch {
      // Fall through to defaults
    }
  }
  const defaults = DEFAULT_PRICING[model]
  if (defaults) return defaults
  // eslint-disable-next-line no-console
  console.warn(
    `[llm-gateway] No pricing for model "${model}". Add override via setting "llm.pricing.${model}" = {"input":X,"output":Y}.`,
  )
  return null
}

/**
 * Compute USD cost given provider-reported token counts. Returns 0
 * when pricing is unknown (so we never double-count missing data).
 */
export async function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): Promise<number> {
  const pricing = await getPricing(model)
  if (!pricing) return 0
  // Per 1M tokens → divide counts by 1e6.
  const inputCost = (inputTokens / 1_000_000) * pricing.input
  const outputCost = (outputTokens / 1_000_000) * pricing.output
  return Number((inputCost + outputCost).toFixed(6))
}

// ── Cost cap enforcement ────────────────────────────────

interface CapCacheEntry {
  spent: number
  expiresAt: number
}
let capCache: CapCacheEntry | null = null
const CAP_CACHE_TTL_MS = 60_000

/** Test-only: force a fresh SUM on the next call. */
export function _resetCostCapCacheForTests(): void {
  capCache = null
}

/**
 * Read `SUM(cost_usd)` over the last 24h, cached per 60s.
 */
async function getSpentUsdToday(): Promise<number> {
  const now = Date.now()
  if (capCache && capCache.expiresAt > now) return capCache.spent
  const row = await dbGet(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
     FROM llm_gateway_logs
     WHERE error IS NULL
       AND created_at >= datetime('now', '-1 day')`,
  )
  const spent = Number(row?.['total'] ?? 0)
  capCache = { spent, expiresAt: now + CAP_CACHE_TTL_MS }
  return spent
}

/**
 * Throw {@link CostCapExceededError} when spent ≥ cap. Call BEFORE the
 * provider fetch so over-budget calls never leave the gateway.
 *
 * `llm.cost_cap_usd_per_day = "0"` disables the cap (explicit opt-out).
 * Missing/invalid setting falls back to the hardcoded "1.0" default.
 */
export async function enforceCostCap(): Promise<void> {
  const raw = await getSetting('llm.cost_cap_usd_per_day')
  const cap = raw === null ? 1.0 : Number(raw)
  if (!Number.isFinite(cap) || cap <= 0) {
    // Admin explicitly disabled or supplied nonsense → skip.
    return
  }
  const spent = await getSpentUsdToday()
  if (spent >= cap) {
    throw new CostCapExceededError(spent, cap)
  }
}

/** Bump the in-memory cap cache after a successful call so the next
 * enforceCostCap sees fresh-ish data without a DB query. */
export function bumpSpentCache(deltaUsd: number): void {
  if (!capCache) return
  capCache.spent += deltaUsd
}

// ── Token estimation fallback ────────────────────────────
// Providers usually return usage in the response body. When they don't
// (e.g. Gemini streaming error) we fall back to a char/4 heuristic.
// `tokensEstimated = true` gets flagged on the ChatResponse so
// downstream analytics can discount these numbers.

/** Rough English-biased estimate: ~4 chars/token. Good for ballpark, bad
 * for CJK — matches TOKEN_TRACKING_PLAN L2's own caveat. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

/** Provider type used for analytics/warnings. */
export type { ProviderType }
