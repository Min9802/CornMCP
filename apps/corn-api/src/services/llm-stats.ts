// ─── LLM stats aggregation (S6.1 / S6.4) ────────────────
// Aggregates `llm_gateway_logs` for the admin Cost dashboard widget.
// Single read-side service that the S6 UI calls — no caching here
// because the data is admin-facing (small audience, 60s SWR is enough)
// and the underlying logs table is indexed on `created_at DESC` +
// `(task_name, created_at)` + `(provider_id, created_at)`.
//
// Why not piggyback on `cost.ts:getSpentUsdToday()`? That helper is
// scoped to cap enforcement and exposes only "today + 60s cache".
// Admin UI needs N-day windows, per-task + per-provider breakdowns,
// and cache-hit %, which would either bloat that helper or force
// duplicate code paths. Keep them separated by audience: hot-path
// enforcement vs cold-path analytics.

import { dbAll, dbGet } from '../db/client.js'
import { getSetting } from './settings.js'

// Cap windowed reads at 90 days even if the caller passes more — keeps
// the GROUP BY bounded since `llm_gateway_logs` retention is currently
// unbounded (S4 rollback note: revisit when row count > 100k).
const MAX_DAYS = 90

export interface LlmStatsTotals {
  /** Inclusive of cached + errored rows. */
  totalCalls: number
  successfulCalls: number
  cachedCalls: number
  erroredCalls: number
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  avgLatencyMs: number
  /** `cachedCalls / totalCalls` rounded to 4 decimals (0.0 when zero calls). */
  cacheHitRate: number
}

export interface LlmStatsBreakdown {
  key: string
  calls: number
  costUsd: number
  avgLatencyMs: number
  cachedRate: number
}

export interface LlmStats {
  windowDays: number
  generatedAt: string
  totals: LlmStatsTotals
  byTask: LlmStatsBreakdown[]
  byProvider: LlmStatsBreakdown[]
  byModel: LlmStatsBreakdown[]
  /** Last 5 errors with task + message + when. UI shows them as a tooltip. */
  recentErrors: { taskName: string | null; provider: string | null; model: string | null; error: string; createdAt: string }[]
}

export interface CostCapStatus {
  /** USD spent in the last 24h, error rows excluded (matches enforceCostCap). */
  spentUsd: number
  /** Cap from `llm.cost_cap_usd_per_day`. 0 = disabled. */
  capUsd: number
  /** Always 0..1 when cap > 0; null when cap is disabled. */
  pctUsed: number | null
  /** True when ≥ 80% of the cap. UI flips the badge to red. */
  warning: boolean
  /** True when ≥ cap. UI shows "Cap reached — calls blocked". */
  exceeded: boolean
}

function clampDays(input: unknown): number {
  const n = Number(input)
  if (!Number.isFinite(n) || n <= 0) return 1
  return Math.min(Math.floor(n), MAX_DAYS)
}

function rate(num: number, denom: number): number {
  if (denom <= 0) return 0
  return Math.round((num / denom) * 10000) / 10000
}

/**
 * Aggregate stats for the last `days` days. Default 1 (today).
 * Pass `days=7` for the weekly card, `days=30` for monthly.
 *
 * GROUP BYs run in parallel via Promise.all because the indexes are
 * disjoint — `(task_name, created)` and `(provider_id, created)`.
 */
export async function getLlmStats(days: number = 1): Promise<LlmStats> {
  const window = clampDays(days)
  const since = `datetime('now', '-${window} day')`

  const [totalsRow, byTaskRows, byProviderRows, byModelRows, errorRows] = await Promise.all([
    dbGet(
      `SELECT
         COUNT(*)                                              AS total_calls,
         SUM(CASE WHEN error IS NULL THEN 1 ELSE 0 END)        AS success_calls,
         SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END)           AS cached_calls,
         SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END)    AS errored_calls,
         COALESCE(SUM(CASE WHEN error IS NULL THEN cost_usd END), 0) AS total_cost,
         COALESCE(SUM(input_tokens), 0)                        AS in_tokens,
         COALESCE(SUM(output_tokens), 0)                       AS out_tokens,
         COALESCE(AVG(CASE WHEN cached = 0 AND error IS NULL THEN latency_ms END), 0) AS avg_latency
       FROM llm_gateway_logs
       WHERE created_at >= ${since}`,
    ),
    dbAll(
      `SELECT
         COALESCE(task_name, '(none)') AS k,
         COUNT(*)                       AS calls,
         COALESCE(SUM(cost_usd), 0)     AS cost,
         COALESCE(AVG(latency_ms), 0)   AS lat,
         SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) AS cached_calls
       FROM llm_gateway_logs
       WHERE created_at >= ${since}
       GROUP BY k
       ORDER BY cost DESC, calls DESC
       LIMIT 25`,
    ),
    dbAll(
      `SELECT
         COALESCE(provider, '(unknown)') AS k,
         COUNT(*)                         AS calls,
         COALESCE(SUM(cost_usd), 0)       AS cost,
         COALESCE(AVG(latency_ms), 0)     AS lat,
         SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) AS cached_calls
       FROM llm_gateway_logs
       WHERE created_at >= ${since}
       GROUP BY k
       ORDER BY cost DESC, calls DESC`,
    ),
    dbAll(
      `SELECT
         COALESCE(model, '(unknown)') AS k,
         COUNT(*)                      AS calls,
         COALESCE(SUM(cost_usd), 0)    AS cost,
         COALESCE(AVG(latency_ms), 0)  AS lat,
         SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) AS cached_calls
       FROM llm_gateway_logs
       WHERE created_at >= ${since}
       GROUP BY k
       ORDER BY cost DESC, calls DESC
       LIMIT 25`,
    ),
    dbAll(
      `SELECT task_name, provider, model, error, created_at
       FROM llm_gateway_logs
       WHERE error IS NOT NULL
         AND created_at >= ${since}
       ORDER BY created_at DESC
       LIMIT 5`,
    ),
  ])

  const total = Number(totalsRow?.['total_calls'] ?? 0)
  const cached = Number(totalsRow?.['cached_calls'] ?? 0)

  const totals: LlmStatsTotals = {
    totalCalls: total,
    successfulCalls: Number(totalsRow?.['success_calls'] ?? 0),
    cachedCalls: cached,
    erroredCalls: Number(totalsRow?.['errored_calls'] ?? 0),
    totalCostUsd: Math.round(Number(totalsRow?.['total_cost'] ?? 0) * 1_000_000) / 1_000_000,
    totalInputTokens: Number(totalsRow?.['in_tokens'] ?? 0),
    totalOutputTokens: Number(totalsRow?.['out_tokens'] ?? 0),
    avgLatencyMs: Math.round(Number(totalsRow?.['avg_latency'] ?? 0)),
    cacheHitRate: rate(cached, total),
  }

  const toBreakdown = (rows: Record<string, unknown>[]): LlmStatsBreakdown[] =>
    rows.map((r) => {
      const calls = Number(r['calls'] ?? 0)
      return {
        key: String(r['k'] ?? '(none)'),
        calls,
        costUsd: Math.round(Number(r['cost'] ?? 0) * 1_000_000) / 1_000_000,
        avgLatencyMs: Math.round(Number(r['lat'] ?? 0)),
        cachedRate: rate(Number(r['cached_calls'] ?? 0), calls),
      }
    })

  return {
    windowDays: window,
    generatedAt: new Date().toISOString(),
    totals,
    byTask: toBreakdown(byTaskRows),
    byProvider: toBreakdown(byProviderRows),
    byModel: toBreakdown(byModelRows),
    recentErrors: errorRows.map((r) => ({
      taskName: (r['task_name'] as string | null) ?? null,
      provider: (r['provider'] as string | null) ?? null,
      model: (r['model'] as string | null) ?? null,
      error: String(r['error'] ?? ''),
      createdAt: String(r['created_at'] ?? ''),
    })),
  }
}

/**
 * Daily cost cap status. Mirrors the same window/exclusion as
 * `enforceCostCap()` so admin sees the same number the gateway sees
 * when it decides to throw `CostCapExceededError`.
 */
export async function getCostCapStatus(): Promise<CostCapStatus> {
  const [spentRow, capRaw] = await Promise.all([
    dbGet(
      `SELECT COALESCE(SUM(cost_usd), 0) AS spent
       FROM llm_gateway_logs
       WHERE error IS NULL
         AND created_at >= datetime('now', '-1 day')`,
    ),
    getSetting('llm.cost_cap_usd_per_day'),
  ])

  const spent = Math.round(Number(spentRow?.['spent'] ?? 0) * 1_000_000) / 1_000_000
  const capNum = capRaw === null ? 1.0 : Number(capRaw)
  const cap = Number.isFinite(capNum) && capNum > 0 ? capNum : 0

  if (cap === 0) {
    return { spentUsd: spent, capUsd: 0, pctUsed: null, warning: false, exceeded: false }
  }

  const pct = spent / cap
  return {
    spentUsd: spent,
    capUsd: cap,
    pctUsed: Math.round(pct * 10000) / 10000,
    warning: pct >= 0.8,
    exceeded: pct >= 1,
  }
}
