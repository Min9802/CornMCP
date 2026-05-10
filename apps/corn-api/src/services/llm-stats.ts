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

import type { PipelineStage } from 'mongoose'
import { LlmGatewayLog } from '../db/mongoose/index.js'
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
// Pipeline shapes for the GROUP BY breakdowns. Mongoose returns these
// raw from the aggregation framework; we flatten + sort below.
interface BreakdownAggRow {
  _id: string | null
  calls: number
  cost: number
  lat: number | null
  cached_calls: number
}

interface TotalsAggRow {
  total_calls: number
  success_calls: number
  cached_calls: number
  errored_calls: number
  total_cost: number
  in_tokens: number
  out_tokens: number
  avg_latency: number | null
}

interface ErrorAggRow {
  task_name: string | null
  provider: string | null
  model: string | null
  error: string | null
  created_at: Date | null
}

export async function getLlmStats(days: number = 1): Promise<LlmStats> {
  const window = clampDays(days)
  const since = new Date(Date.now() - window * 24 * 60 * 60 * 1000)
  const matchSince = { created_at: { $gte: since } }

  // Conditional accumulators replace the SQL CASE WHEN expressions.
  const successCond = { $cond: [{ $eq: ['$error', null] }, 1, 0] }
  const cachedCond = { $cond: [{ $eq: ['$cached', true] }, 1, 0] }
  const erroredCond = { $cond: [{ $eq: ['$error', null] }, 0, 1] }
  const successCostCond = { $cond: [{ $eq: ['$error', null] }, '$cost_usd', 0] }
  // Latency average excludes cached + errored rows so the number
  // reflects real provider call time.
  const realLatencyCond = {
    $cond: [
      { $and: [{ $eq: ['$cached', false] }, { $eq: ['$error', null] }] },
      '$latency_ms',
      null,
    ],
  }

  function buildBreakdownPipeline(field: string, fallbackKey: string, limit?: number): PipelineStage[] {
    const pipeline: PipelineStage[] = [
      { $match: matchSince },
      {
        $group: {
          _id: { $ifNull: [`$${field}`, fallbackKey] },
          calls: { $sum: 1 },
          cost: { $sum: '$cost_usd' },
          lat: { $avg: '$latency_ms' },
          cached_calls: { $sum: cachedCond },
        },
      },
      { $sort: { cost: -1, calls: -1 } },
    ]
    if (limit) pipeline.push({ $limit: limit })
    return pipeline
  }

  const [totalsRows, byTaskRows, byProviderRows, byModelRows, errorRows] = await Promise.all([
    LlmGatewayLog.aggregate<TotalsAggRow>([
      { $match: matchSince },
      {
        $group: {
          _id: null,
          total_calls: { $sum: 1 },
          success_calls: { $sum: successCond },
          cached_calls: { $sum: cachedCond },
          errored_calls: { $sum: erroredCond },
          total_cost: { $sum: successCostCond },
          in_tokens: { $sum: '$input_tokens' },
          out_tokens: { $sum: '$output_tokens' },
          avg_latency: { $avg: realLatencyCond },
        },
      },
    ]),
    LlmGatewayLog.aggregate<BreakdownAggRow>(
      buildBreakdownPipeline('task_name', '(none)', 25),
    ),
    LlmGatewayLog.aggregate<BreakdownAggRow>(
      buildBreakdownPipeline('provider', '(unknown)'),
    ),
    LlmGatewayLog.aggregate<BreakdownAggRow>(
      buildBreakdownPipeline('model', '(unknown)', 25),
    ),
    LlmGatewayLog.aggregate<ErrorAggRow>([
      { $match: { ...matchSince, error: { $ne: null } } },
      { $sort: { created_at: -1 } },
      { $limit: 5 },
      {
        $project: {
          _id: 0,
          task_name: 1,
          provider: 1,
          model: 1,
          error: 1,
          created_at: 1,
        },
      },
    ]),
  ])

  const totalsRow = totalsRows[0]
  const total = Number(totalsRow?.total_calls ?? 0)
  const cached = Number(totalsRow?.cached_calls ?? 0)

  const totals: LlmStatsTotals = {
    totalCalls: total,
    successfulCalls: Number(totalsRow?.success_calls ?? 0),
    cachedCalls: cached,
    erroredCalls: Number(totalsRow?.errored_calls ?? 0),
    totalCostUsd: Math.round(Number(totalsRow?.total_cost ?? 0) * 1_000_000) / 1_000_000,
    totalInputTokens: Number(totalsRow?.in_tokens ?? 0),
    totalOutputTokens: Number(totalsRow?.out_tokens ?? 0),
    avgLatencyMs: Math.round(Number(totalsRow?.avg_latency ?? 0)),
    cacheHitRate: rate(cached, total),
  }

  const toBreakdown = (rows: BreakdownAggRow[]): LlmStatsBreakdown[] =>
    rows.map((r) => {
      const calls = Number(r.calls ?? 0)
      return {
        key: String(r._id ?? '(none)'),
        calls,
        costUsd: Math.round(Number(r.cost ?? 0) * 1_000_000) / 1_000_000,
        avgLatencyMs: Math.round(Number(r.lat ?? 0)),
        cachedRate: rate(Number(r.cached_calls ?? 0), calls),
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
      taskName: r.task_name ?? null,
      provider: r.provider ?? null,
      model: r.model ?? null,
      error: String(r.error ?? ''),
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
    })),
  }
}

/**
 * Daily cost cap status. Mirrors the same window/exclusion as
 * `enforceCostCap()` so admin sees the same number the gateway sees
 * when it decides to throw `CostCapExceededError`.
 */
export async function getCostCapStatus(): Promise<CostCapStatus> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const [spentAgg, capRaw] = await Promise.all([
    LlmGatewayLog.aggregate<{ spent: number }>([
      { $match: { error: null, created_at: { $gte: since } } },
      { $group: { _id: null, spent: { $sum: '$cost_usd' } } },
    ]),
    getSetting('llm.cost_cap_usd_per_day'),
  ])

  const spent = Math.round(Number(spentAgg[0]?.spent ?? 0) * 1_000_000) / 1_000_000
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
