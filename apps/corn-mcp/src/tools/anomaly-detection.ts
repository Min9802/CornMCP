// ─── Anomaly Detection (S7.7) ──────────────────────────
// Flag anomalous values in a numeric time series. Advisory — the
// task returns a list of suspected anomalies with severity + reason
// for the agent to decide next steps. No DB writes, no side effects.
//
// Two engines that share the same output shape:
//   - `heuristic`: z-score test against a baseline mean/stddev. Values
//                  with |z| ≥ 2 are flagged; |z| ≥ 3 labeled `high`.
//                  Pure function, no IO.
//   - `llm`:       chat completion that returns a JSON `{anomalies:[...]}`
//                  list. Useful for metrics where the distribution is
//                  non-Gaussian or the agent wants a human-readable
//                  explanation.
//
// Input shape keeps the call cheap: the caller either supplies an
// explicit baseline (mean, stddev) or leaves it out and the heuristic
// derives one from the first 80% of the series (tail 20% = "recent").

import {
  chatCompleteRemote,
  registerTask,
  type RunContext,
  type RemoteChatRequest,
} from '../services/task-dispatcher.js'

export interface AnomalyMetric {
  /** Human-readable metric name (e.g. "cost_usd_per_hour"). */
  name: string
  /** Numeric values, ordered oldest → newest. */
  values: number[]
  /** Optional explicit baseline; heuristic derives one if omitted. */
  baseline?: { mean: number; stddev: number }
  /** Optional human-readable unit label for the output. */
  unit?: string
}

export interface AnomalyInput {
  metrics: AnomalyMetric[]
  /** z-score threshold for flagging anomalies. Default 2. */
  zThreshold?: number
  /** Fraction of the series used as baseline when `baseline` is omitted. Default 0.8. */
  baselineFraction?: number
}

export type AnomalySeverity = 'low' | 'medium' | 'high'

export interface AnomalyFinding {
  metric: string
  /** Index into the original `values` array. */
  index: number
  value: number
  severity: AnomalySeverity
  /** Short reason — "z=3.1 above mean 0.4±0.1" or llm-supplied. */
  reason: string
}

export interface AnomalyResult {
  anomalies: AnomalyFinding[]
  /** Baselines actually used per metric, surfaced for transparency. */
  baselines: { metric: string; mean: number; stddev: number; source: 'provided' | 'derived' | 'none' }[]
}

export const ANOMALY_DETECTION_TASK_NAME = 'anomaly_detection'

export const DEFAULT_Z_THRESHOLD = 2
export const DEFAULT_BASELINE_FRACTION = 0.8

/** Register the anomaly-detection task. Idempotent. */
export function registerAnomalyDetectionTask(): void {
  registerTask<AnomalyInput, AnomalyResult>(ANOMALY_DETECTION_TASK_NAME, {
    heuristic: runHeuristic,
    llm: runLlm,
  })
}

// ── Heuristic helpers ───────────────────────────────────

function meanStddev(xs: number[]): { mean: number; stddev: number } {
  const n = xs.length
  if (n === 0) return { mean: 0, stddev: 0 }
  const mean = xs.reduce((a, b) => a + b, 0) / n
  if (n === 1) return { mean, stddev: 0 }
  const variance = xs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (n - 1)
  return { mean, stddev: Math.sqrt(variance) }
}

function severityFromZ(absZ: number): AnomalySeverity {
  if (absZ >= 3) return 'high'
  if (absZ >= 2) return 'medium'
  return 'low'
}

// ── Heuristic engine ────────────────────────────────────

export function runHeuristic(input: AnomalyInput): AnomalyResult {
  const metrics = Array.isArray(input?.metrics) ? input.metrics : []
  const zThreshold =
    typeof input.zThreshold === 'number' && input.zThreshold > 0 ? input.zThreshold : DEFAULT_Z_THRESHOLD
  const baseFrac =
    typeof input.baselineFraction === 'number' &&
    input.baselineFraction > 0 &&
    input.baselineFraction < 1
      ? input.baselineFraction
      : DEFAULT_BASELINE_FRACTION

  const anomalies: AnomalyFinding[] = []
  const baselines: AnomalyResult['baselines'] = []

  for (const m of metrics) {
    if (!m || typeof m.name !== 'string') continue
    const values = (Array.isArray(m.values) ? m.values : []).filter((v) => Number.isFinite(v))
    if (values.length === 0) {
      baselines.push({ metric: m.name, mean: 0, stddev: 0, source: 'none' })
      continue
    }

    let baseline: { mean: number; stddev: number }
    let source: 'provided' | 'derived' | 'none' = 'none'
    if (
      m.baseline &&
      Number.isFinite(m.baseline.mean) &&
      Number.isFinite(m.baseline.stddev) &&
      m.baseline.stddev >= 0
    ) {
      baseline = { mean: m.baseline.mean, stddev: m.baseline.stddev }
      source = 'provided'
    } else if (values.length >= 4) {
      const baselineCount = Math.max(2, Math.floor(values.length * baseFrac))
      const baselineSlice = values.slice(0, baselineCount)
      baseline = meanStddev(baselineSlice)
      source = 'derived'
    } else {
      // Not enough data — record baseline but skip z-test.
      baseline = meanStddev(values)
      source = values.length >= 2 ? 'derived' : 'none'
    }

    baselines.push({ metric: m.name, ...baseline, source })

    if (baseline.stddev === 0 || source === 'none') continue

    // Check every value (not just recent) — the heuristic flags any
    // outlier relative to the baseline. Agents can pre-slice if they
    // only care about recent.
    values.forEach((v, i) => {
      const z = (v - baseline.mean) / baseline.stddev
      const absZ = Math.abs(z)
      if (absZ >= zThreshold) {
        anomalies.push({
          metric: m.name,
          index: i,
          value: v,
          severity: severityFromZ(absZ),
          reason: `z=${z.toFixed(2)} (${v.toFixed(3)} vs mean ${baseline.mean.toFixed(3)}±${baseline.stddev.toFixed(3)})`,
        })
      }
    })
  }

  // Stable sort: high → medium → low, then by metric name.
  const sevRank: Record<AnomalySeverity, number> = { high: 0, medium: 1, low: 2 }
  anomalies.sort((a, b) => {
    if (sevRank[a.severity] !== sevRank[b.severity]) return sevRank[a.severity] - sevRank[b.severity]
    return a.metric.localeCompare(b.metric)
  })

  return { anomalies, baselines }
}

// ── LLM engine ──────────────────────────────────────────

const SYSTEM_PROMPT = [
  'You analyze numeric time-series metrics and flag anomalous values.',
  '',
  'Output STRICT JSON with this shape:',
  '{"anomalies":[{"metric":"<name>","index":<int>,"value":<number>,"severity":"low|medium|high","reason":"<short>"}]}',
  '',
  'Rules:',
  '- `index` is the 0-based position in the metric\'s values array.',
  '- `severity` is one of: low, medium, high.',
  '- Keep `reason` ≤120 chars, no markdown, no code fences.',
  '- An empty `anomalies` array is valid when nothing is suspicious.',
  '- Output ONLY the JSON object.',
].join('\n')

function buildUserPrompt(input: AnomalyInput): string {
  const metrics = (Array.isArray(input.metrics) ? input.metrics : []).slice(0, 10)
  const lines: string[] = []
  for (const m of metrics) {
    const values = (Array.isArray(m?.values) ? m.values : []).slice(0, 200)
    const baseline = m?.baseline
      ? `baseline: mean=${m.baseline.mean.toFixed(3)}, stddev=${m.baseline.stddev.toFixed(3)}`
      : 'baseline: <unspecified>'
    lines.push(
      `Metric: ${m?.name ?? '<unnamed>'}${m?.unit ? ` (${m.unit})` : ''}\n${baseline}\nvalues[${values.length}]: ${values.join(', ')}`,
    )
  }
  const threshold = input.zThreshold ?? DEFAULT_Z_THRESHOLD
  return `z-threshold hint: ${threshold}\n\n${lines.join('\n\n---\n\n') || '<no metrics supplied>'}`
}

export async function runLlm(input: AnomalyInput, ctx: RunContext): Promise<AnomalyResult> {
  const config = ctx.config
  if (config.engine !== 'llm') {
    throw new Error('runLlm called with non-llm config')
  }

  if (!Array.isArray(input?.metrics) || input.metrics.length === 0) {
    return { anomalies: [], baselines: [] }
  }

  const model = config.model?.trim() || 'gpt-4o-mini'
  const promptOverride = config.prompt_template?.trim()
  const userContent = buildUserPrompt(input)
  const userPrompt = promptOverride
    ? promptOverride.replace('{{input}}', userContent).replace('{{context}}', userContent)
    : userContent

  const req: RemoteChatRequest = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    maxTokens: config.max_output_tokens || 600,
    temperature: typeof config.temperature === 'number' ? config.temperature : 0.1,
    timeoutMs: config.timeout_ms || 30_000,
    cacheTTLSec: config.cache_ttl_sec,
    taskName: ANOMALY_DETECTION_TASK_NAME,
  }
  if (config.provider_id) req.providerId = config.provider_id

  const resp = await chatCompleteRemote(req, ctx.env)
  const llmAnomalies = parseLlmJson(resp.content, input)

  // Always recompute baselines from the heuristic so the result has a
  // consistent shape regardless of engine. LLM is only judging anomalies,
  // not re-deriving stats.
  const { baselines } = runHeuristic({ ...input, metrics: input.metrics })
  return { anomalies: llmAnomalies, baselines }
}

/**
 * Parse the LLM response into a sanitized list of findings. Only keeps
 * entries whose `metric` is known and whose `index` falls inside the
 * original values array. Severity defaults to `medium` when the model
 * omits or mis-labels it.
 */
export function parseLlmJson(content: string, input: AnomalyInput): AnomalyFinding[] {
  const trimmed = (content ?? '').trim()
  let jsonText = trimmed
  if (trimmed.startsWith('```')) {
    const firstNewline = trimmed.indexOf('\n')
    const fenceClose = trimmed.lastIndexOf('```')
    if (firstNewline > 0 && fenceClose > firstNewline) {
      jsonText = trimmed.slice(firstNewline + 1, fenceClose).trim()
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw new Error(`LLM response was not valid JSON: ${trimmed.slice(0, 200)}`)
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('LLM JSON missing root object')
  }
  const arr = (parsed as { anomalies?: unknown }).anomalies
  if (!Array.isArray(arr)) {
    throw new Error('LLM JSON missing or invalid `anomalies` array')
  }

  const metricMap = new Map<string, number[]>()
  for (const m of input.metrics ?? []) {
    if (m && typeof m.name === 'string') metricMap.set(m.name, Array.isArray(m.values) ? m.values : [])
  }

  const out: AnomalyFinding[] = []
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>
    const metric = typeof obj['metric'] === 'string' ? obj['metric'] : ''
    if (!metricMap.has(metric)) continue

    const values = metricMap.get(metric)!
    const rawIndex = obj['index']
    const index =
      typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < values.length
        ? rawIndex
        : -1
    if (index < 0) continue

    const rawValue = obj['value']
    const value =
      typeof rawValue === 'number' && Number.isFinite(rawValue) ? rawValue : values[index] ?? 0

    const severityRaw = typeof obj['severity'] === 'string' ? obj['severity'].toLowerCase() : ''
    const severity: AnomalySeverity =
      severityRaw === 'low' || severityRaw === 'medium' || severityRaw === 'high' ? severityRaw : 'medium'

    const reason = typeof obj['reason'] === 'string' ? obj['reason'].trim().slice(0, 240) : ''
    out.push({ metric, index, value, severity, reason: reason || 'LLM flagged' })
  }

  const sevRank: Record<AnomalySeverity, number> = { high: 0, medium: 1, low: 2 }
  out.sort((a, b) => {
    if (sevRank[a.severity] !== sevRank[b.severity]) return sevRank[a.severity] - sevRank[b.severity]
    return a.metric.localeCompare(b.metric)
  })
  return out
}
