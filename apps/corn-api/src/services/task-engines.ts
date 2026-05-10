// ─── Task Engine Registry (S5.2) ────────────────────────
// Per-task config layer for the corn-mcp dispatcher: which engine runs
// (`heuristic` vs `llm`), which provider/model/prompt to use, and the
// safety knobs (timeout, token budget, daily cost cap, cache TTL).
//
// Source-of-truth ordering:
//   1. DB row (`task_engine_config`) — admin overrides.
//   2. `DEFAULT_TASK_ENGINES` constant — hardcoded seed (mirrored into
//      DB by migration 0015). Used when a task name is registered in
//      corn-mcp but the migration hasn't run yet, OR when callers want
//      the canonical default for diff/reset UI.
//
// Cache: 60s in-memory Map invalidated on `updateTaskEngineConfig()`,
// matching the same pattern as `services/settings.ts`. corn-mcp side
// runs its OWN cache (so we don't need pub/sub between processes); the
// API-side cache only spares the DB on burst reads from the admin UI.
//
// Validation: `engine` is constrained at schema level. Numeric/string
// fields are normalized in `updateTaskEngineConfig()` so callers can
// pass strings from form posts; nonsense values throw before they
// reach the DB.

import { dbAll, dbGet, dbRun } from '../db/client.js'

// ── Default config for the 10 tasks the plan calls out ──
// Keep ordering aligned with `0015_task_engine_config.sql` seed so the
// admin UI shows the same row order regardless of where defaults come
// from. Description text is admin-facing; keep it short + actionable.
export interface TaskEngineDefaultSpec {
  taskName: string
  description: string
  /** Suggested LLM model when admin flips engine='llm'. Heuristic ignores this. */
  suggestedModel?: string
  /** Default prompt template — `{{input}}` is the substitution token. */
  promptTemplate?: string
  /** Max output tokens hint (per-task, overrides global default). */
  maxOutputTokens?: number
}

export const DEFAULT_TASK_ENGINES: readonly TaskEngineDefaultSpec[] = [
  {
    taskName: 'plan_quality',
    description:
      'Score plans on 8 criteria (clarity/scope/risks/testing/reversibility/impact/dependencies/timeline). LLM mode rates each 0-10 instead of keyword-checking.',
    suggestedModel: 'gpt-4o-mini',
    maxOutputTokens: 800,
  },
  {
    taskName: 'auto_tags_for_memory',
    description:
      'Suggest tags for new memories. Heuristic = simple keyword extraction; LLM = semantic topic extraction.',
    suggestedModel: 'gpt-4o-mini',
    maxOutputTokens: 256,
  },
  {
    taskName: 'session_summary',
    description:
      'Summarize a session log into 2-4 sentences for handoff. Heuristic = first-N-chars truncation; LLM = abstractive summary.',
    suggestedModel: 'gpt-4o-mini',
    maxOutputTokens: 400,
  },
  {
    taskName: 'quality_report_assist',
    description:
      'Auto-fill the 4-dimension quality scores from a git diff + session log. Heuristic = simple rules; LLM = qualitative assessment.',
    suggestedModel: 'gpt-4o-mini',
    maxOutputTokens: 600,
  },
  {
    taskName: 'memory_dedup',
    description:
      'Detect duplicate memory entries. Heuristic = vector cosine threshold; LLM = semantic equivalence judge.',
    suggestedModel: 'gpt-4o-mini',
    maxOutputTokens: 256,
  },
  {
    taskName: 'code_search_rerank',
    description:
      'Rerank top-K code search results by relevance. Heuristic = score order; LLM = intent-aware rerank.',
    suggestedModel: 'gpt-4o-mini',
    maxOutputTokens: 512,
  },
  {
    taskName: 'anomaly_detection',
    description:
      'Flag anomalous query/cost patterns. Heuristic = static threshold; LLM = pattern recognition.',
    suggestedModel: 'gpt-4o-mini',
    maxOutputTokens: 400,
  },
  {
    taskName: 'token_count',
    description:
      'Count tokens for an arbitrary string. Heuristic = local BPE (TOKEN L2); LLM = provider tokenizer API as fallback.',
    suggestedModel: 'gpt-4o-mini',
    maxOutputTokens: 64,
  },
  {
    taskName: 'knowledge_dedup',
    description:
      'Detect duplicate knowledge documents. Same approach as memory_dedup.',
    suggestedModel: 'gpt-4o-mini',
    maxOutputTokens: 256,
  },
  {
    taskName: 'chat_assistant',
    description:
      'New MCP tool corn_chat. Heuristic = unsupported (returns error); LLM = full chat completion via gateway.',
    suggestedModel: 'gpt-4o-mini',
    maxOutputTokens: 1024,
  },
] as const

// ── Public types ────────────────────────────────────────

export type TaskEngineKind = 'heuristic' | 'llm'

export interface TaskEngineConfig {
  task_name: string
  engine: TaskEngineKind
  provider_id: string | null
  model: string | null
  enabled: 0 | 1
  fallback_to_heuristic: 0 | 1
  prompt_template: string | null
  timeout_ms: number
  max_input_tokens: number
  max_output_tokens: number
  temperature: number
  cache_ttl_sec: number
  cost_cap_usd_per_day: number
  description: string | null
  updated_by: string | null
  updated_at: string
}

export interface TaskEngineUpdate {
  engine?: TaskEngineKind
  providerId?: string | null
  model?: string | null
  enabled?: boolean
  fallbackToHeuristic?: boolean
  promptTemplate?: string | null
  timeoutMs?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  temperature?: number
  cacheTtlSec?: number
  costCapUsdPerDay?: number
  description?: string | null
  updatedBy?: string
}

export type TaskEngineAuditAction = 'update' | 'test' | 'reset'

export interface TaskEngineAuditEntry {
  id: number
  task_name: string
  field: string
  old_value: string | null
  new_value: string | null
  action: TaskEngineAuditAction
  changed_by: string | null
  changed_at: string
}

// Columns we track in the audit table. Order is stable so test output
// stays deterministic — UI sorts by changed_at anyway, but tests assert
// on the first-N rows after a single update.
const AUDIT_FIELDS = [
  'engine',
  'provider_id',
  'model',
  'enabled',
  'fallback_to_heuristic',
  'prompt_template',
  'timeout_ms',
  'max_input_tokens',
  'max_output_tokens',
  'temperature',
  'cache_ttl_sec',
  'cost_cap_usd_per_day',
  'description',
] as const

// Coerce a column value to the audit-friendly TEXT representation.
// Numbers stringify, booleans land as '0'/'1' (matches SQLite INTEGER
// columns), null/undefined collapse to NULL — the UI renders these as
// `<empty>`. Keep the rules narrow so a regression in caller code
// doesn't silently log `[object Object]`.
function toAuditValue(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? '1' : '0'
  return String(v)
}

// Diff two row-shaped objects (existing DB row vs the merged patch) and
// emit one audit row per *changed* field. Skipped when nothing changes
// — re-saving an unchanged row is silent.
async function recordAuditDiff(
  taskName: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  changedBy: string,
): Promise<void> {
  for (const field of AUDIT_FIELDS) {
    const oldStr = toAuditValue(before ? before[field] : null)
    const newStr = toAuditValue(after[field])
    if (oldStr === newStr) continue
    await dbRun(
      `INSERT INTO task_engine_audit (task_name, field, old_value, new_value, action, changed_by)
       VALUES (?, ?, ?, ?, 'update', ?)`,
      [taskName, field, oldStr, newStr, changedBy],
    )
  }
}

// ── Cache ────────────────────────────────────────────────
interface CacheEntry {
  value: TaskEngineConfig | null
  expiresAt: number
}
const cache = new Map<string, CacheEntry>()
const DEFAULT_TTL_MS = 60_000

function ttlMs(): number {
  const env = Number(process.env['TASK_ENGINE_CACHE_TTL_MS'])
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_TTL_MS
}

/** Test-only: clear the in-process cache. Not for production paths. */
export function _clearTaskEngineCacheForTests(): void {
  cache.clear()
}

// ── Row → typed config ──────────────────────────────────

function rowToConfig(row: Record<string, unknown>): TaskEngineConfig {
  return {
    task_name: row['task_name'] as string,
    engine: ((row['engine'] as string) === 'llm' ? 'llm' : 'heuristic') as TaskEngineKind,
    provider_id: (row['provider_id'] as string | null) ?? null,
    model: (row['model'] as string | null) ?? null,
    enabled: (row['enabled'] as number) === 0 ? 0 : 1,
    fallback_to_heuristic:
      (row['fallback_to_heuristic'] as number) === 0 ? 0 : 1,
    prompt_template: (row['prompt_template'] as string | null) ?? null,
    timeout_ms: Number(row['timeout_ms'] ?? 30_000),
    max_input_tokens: Number(row['max_input_tokens'] ?? 8000),
    max_output_tokens: Number(row['max_output_tokens'] ?? 1024),
    temperature: Number(row['temperature'] ?? 0.2),
    cache_ttl_sec: Number(row['cache_ttl_sec'] ?? 3600),
    cost_cap_usd_per_day: Number(row['cost_cap_usd_per_day'] ?? 0),
    description: (row['description'] as string | null) ?? null,
    updated_by: (row['updated_by'] as string | null) ?? null,
    updated_at: (row['updated_at'] as string) ?? '',
  }
}

/** Build a "default" config object for tasks not yet seeded into the DB. */
function defaultConfigFor(taskName: string): TaskEngineConfig {
  const spec = DEFAULT_TASK_ENGINES.find((s) => s.taskName === taskName)
  return {
    task_name: taskName,
    engine: 'heuristic',
    provider_id: null,
    model: spec?.suggestedModel ?? null,
    enabled: 1,
    fallback_to_heuristic: 1,
    prompt_template: spec?.promptTemplate ?? null,
    timeout_ms: 30_000,
    max_input_tokens: 8000,
    max_output_tokens: spec?.maxOutputTokens ?? 1024,
    temperature: 0.2,
    cache_ttl_sec: 3600,
    cost_cap_usd_per_day: 0,
    description: spec?.description ?? null,
    updated_by: null,
    updated_at: '',
  }
}

// ── Public API ──────────────────────────────────────────

/**
 * Resolve the effective config for a task. Falls back to
 * {@link DEFAULT_TASK_ENGINES} entry (or a generic heuristic default
 * when the task is unknown) so callers always get a usable object.
 *
 * Cached per-task for {@link DEFAULT_TTL_MS} (60s default, override via
 * `TASK_ENGINE_CACHE_TTL_MS`). Mutations call
 * {@link updateTaskEngineConfig} which invalidates the cache for that key.
 */
export async function getTaskEngineConfig(taskName: string): Promise<TaskEngineConfig> {
  const now = Date.now()
  const hit = cache.get(taskName)
  if (hit && hit.expiresAt > now) {
    return hit.value ?? defaultConfigFor(taskName)
  }

  const row = await dbGet(
    `SELECT task_name, engine, provider_id, model, enabled, fallback_to_heuristic,
            prompt_template, timeout_ms, max_input_tokens, max_output_tokens,
            temperature, cache_ttl_sec, cost_cap_usd_per_day, description,
            updated_by, updated_at
     FROM task_engine_config WHERE task_name = ?`,
    [taskName],
  )

  const value = row ? rowToConfig(row) : null
  cache.set(taskName, { value, expiresAt: now + ttlMs() })
  return value ?? defaultConfigFor(taskName)
}

/**
 * List all task configs. Merges DB rows with the default seed so the
 * admin UI sees every known task even before migration runs (or when
 * an admin reset the table).
 */
export async function listTaskEngineConfigs(): Promise<TaskEngineConfig[]> {
  const rows = await dbAll(
    `SELECT task_name, engine, provider_id, model, enabled, fallback_to_heuristic,
            prompt_template, timeout_ms, max_input_tokens, max_output_tokens,
            temperature, cache_ttl_sec, cost_cap_usd_per_day, description,
            updated_by, updated_at
     FROM task_engine_config ORDER BY task_name ASC`,
  )
  const byName = new Map<string, TaskEngineConfig>()
  for (const row of rows) {
    const cfg = rowToConfig(row)
    byName.set(cfg.task_name, cfg)
  }
  // Surface defaults for any task that hasn't been seeded yet so the UI
  // can render a row + "Save" call ends up creating it.
  for (const spec of DEFAULT_TASK_ENGINES) {
    if (!byName.has(spec.taskName)) byName.set(spec.taskName, defaultConfigFor(spec.taskName))
  }
  return [...byName.values()].sort((a, b) => a.task_name.localeCompare(b.task_name))
}

/**
 * Upsert a task config. Validates inputs (engine value, numeric ranges)
 * and invalidates the local cache for the key. Pass `engine='llm'` with
 * `providerId=null` and the dispatcher will rely on the gateway's
 * default-provider resolution (S4.10 virtual env fallback).
 */
export async function updateTaskEngineConfig(
  taskName: string,
  patch: TaskEngineUpdate,
): Promise<TaskEngineConfig> {
  if (!taskName || typeof taskName !== 'string') {
    throw new Error('taskName is required')
  }
  if (patch.engine && patch.engine !== 'heuristic' && patch.engine !== 'llm') {
    throw new Error(`engine must be 'heuristic' or 'llm', got ${String(patch.engine)}`)
  }
  if (patch.timeoutMs !== undefined && (!Number.isFinite(patch.timeoutMs) || patch.timeoutMs <= 0)) {
    throw new Error('timeoutMs must be a positive number')
  }
  if (
    patch.maxInputTokens !== undefined &&
    (!Number.isFinite(patch.maxInputTokens) || patch.maxInputTokens <= 0)
  ) {
    throw new Error('maxInputTokens must be a positive number')
  }
  if (
    patch.maxOutputTokens !== undefined &&
    (!Number.isFinite(patch.maxOutputTokens) || patch.maxOutputTokens <= 0)
  ) {
    throw new Error('maxOutputTokens must be a positive number')
  }
  if (
    patch.temperature !== undefined &&
    (!Number.isFinite(patch.temperature) || patch.temperature < 0 || patch.temperature > 2)
  ) {
    throw new Error('temperature must be in [0, 2]')
  }
  if (
    patch.cacheTtlSec !== undefined &&
    (!Number.isFinite(patch.cacheTtlSec) || patch.cacheTtlSec < 0)
  ) {
    throw new Error('cacheTtlSec must be ≥ 0')
  }
  if (
    patch.costCapUsdPerDay !== undefined &&
    (!Number.isFinite(patch.costCapUsdPerDay) || patch.costCapUsdPerDay < 0)
  ) {
    throw new Error('costCapUsdPerDay must be ≥ 0')
  }

  const existing = await dbGet(
    `SELECT task_name, engine, provider_id, model, enabled, fallback_to_heuristic,
            prompt_template, timeout_ms, max_input_tokens, max_output_tokens,
            temperature, cache_ttl_sec, cost_cap_usd_per_day, description
     FROM task_engine_config WHERE task_name = ?`,
    [taskName],
  )

  // Build the merged row using either the existing DB values or the
  // hardcoded defaults so a brand-new task gets sane numbers without
  // the admin having to fill every field.
  const fallback = defaultConfigFor(taskName)
  const merged = {
    engine:
      patch.engine ?? (existing ? ((existing['engine'] as string) === 'llm' ? 'llm' : 'heuristic') : fallback.engine),
    provider_id:
      patch.providerId === undefined
        ? ((existing?.['provider_id'] as string | null) ?? fallback.provider_id)
        : patch.providerId,
    model:
      patch.model === undefined
        ? ((existing?.['model'] as string | null) ?? fallback.model)
        : patch.model,
    enabled:
      patch.enabled === undefined
        ? ((existing?.['enabled'] as number | undefined) ?? fallback.enabled)
        : patch.enabled
        ? 1
        : 0,
    fallback_to_heuristic:
      patch.fallbackToHeuristic === undefined
        ? ((existing?.['fallback_to_heuristic'] as number | undefined) ??
          fallback.fallback_to_heuristic)
        : patch.fallbackToHeuristic
        ? 1
        : 0,
    prompt_template:
      patch.promptTemplate === undefined
        ? ((existing?.['prompt_template'] as string | null) ?? fallback.prompt_template)
        : patch.promptTemplate,
    timeout_ms:
      patch.timeoutMs ?? Number(existing?.['timeout_ms'] ?? fallback.timeout_ms),
    max_input_tokens:
      patch.maxInputTokens ??
      Number(existing?.['max_input_tokens'] ?? fallback.max_input_tokens),
    max_output_tokens:
      patch.maxOutputTokens ??
      Number(existing?.['max_output_tokens'] ?? fallback.max_output_tokens),
    temperature: patch.temperature ?? Number(existing?.['temperature'] ?? fallback.temperature),
    cache_ttl_sec:
      patch.cacheTtlSec ?? Number(existing?.['cache_ttl_sec'] ?? fallback.cache_ttl_sec),
    cost_cap_usd_per_day:
      patch.costCapUsdPerDay ??
      Number(existing?.['cost_cap_usd_per_day'] ?? fallback.cost_cap_usd_per_day),
    description:
      patch.description === undefined
        ? ((existing?.['description'] as string | null) ?? fallback.description)
        : patch.description,
  }

  if (existing) {
    await dbRun(
      `UPDATE task_engine_config SET
         engine = ?, provider_id = ?, model = ?, enabled = ?,
         fallback_to_heuristic = ?, prompt_template = ?, timeout_ms = ?,
         max_input_tokens = ?, max_output_tokens = ?, temperature = ?,
         cache_ttl_sec = ?, cost_cap_usd_per_day = ?, description = ?,
         updated_by = ?, updated_at = datetime('now')
       WHERE task_name = ?`,
      [
        merged.engine,
        merged.provider_id,
        merged.model,
        merged.enabled,
        merged.fallback_to_heuristic,
        merged.prompt_template,
        merged.timeout_ms,
        merged.max_input_tokens,
        merged.max_output_tokens,
        merged.temperature,
        merged.cache_ttl_sec,
        merged.cost_cap_usd_per_day,
        merged.description,
        patch.updatedBy ?? 'system',
        taskName,
      ],
    )
  } else {
    await dbRun(
      `INSERT INTO task_engine_config
         (task_name, engine, provider_id, model, enabled,
          fallback_to_heuristic, prompt_template, timeout_ms,
          max_input_tokens, max_output_tokens, temperature,
          cache_ttl_sec, cost_cap_usd_per_day, description, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskName,
        merged.engine,
        merged.provider_id,
        merged.model,
        merged.enabled,
        merged.fallback_to_heuristic,
        merged.prompt_template,
        merged.timeout_ms,
        merged.max_input_tokens,
        merged.max_output_tokens,
        merged.temperature,
        merged.cache_ttl_sec,
        merged.cost_cap_usd_per_day,
        merged.description,
        patch.updatedBy ?? 'system',
      ],
    )
  }

  // Append per-field audit rows AFTER the write succeeds. We deliberately
  // diff against the existing row (or null = creation) rather than the
  // hardcoded fallback so audit shows actual admin intent — e.g. "engine:
  // heuristic → llm" not "engine: → llm" on first edit.
  await recordAuditDiff(taskName, existing ?? null, merged, patch.updatedBy ?? 'system')

  cache.delete(taskName)
  return getTaskEngineConfig(taskName)
}

/**
 * List audit entries (per-field changes). Default 50, max 500. Filter
 * to a single task with `taskName` for the per-row history modal; omit
 * for the global "recent activity" feed.
 */
export async function getTaskEngineAudit(
  opts: { taskName?: string; limit?: number } = {},
): Promise<TaskEngineAuditEntry[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 500)
  const rows = opts.taskName
    ? await dbAll(
        `SELECT id, task_name, field, old_value, new_value, action, changed_by, changed_at
         FROM task_engine_audit
         WHERE task_name = ?
         ORDER BY changed_at DESC, id DESC
         LIMIT ?`,
        [opts.taskName, limit],
      )
    : await dbAll(
        `SELECT id, task_name, field, old_value, new_value, action, changed_by, changed_at
         FROM task_engine_audit
         ORDER BY changed_at DESC, id DESC
         LIMIT ?`,
        [limit],
      )
  return rows.map((r) => ({
    id: Number(r['id']),
    task_name: (r['task_name'] as string) ?? '',
    field: (r['field'] as string) ?? '',
    old_value: (r['old_value'] as string | null) ?? null,
    new_value: (r['new_value'] as string | null) ?? null,
    action: ((r['action'] as string) === 'test' || r['action'] === 'reset' ? r['action'] : 'update') as TaskEngineAuditAction,
    changed_by: (r['changed_by'] as string | null) ?? null,
    changed_at: (r['changed_at'] as string) ?? '',
  }))
}

/**
 * Append a single audit row out-of-band of `updateTaskEngineConfig`.
 * Used by the test endpoint (action='test') to record "who ran a
 * test prompt and what it cost" and by the Reset-to-default UI button
 * (action='reset') for a single "reset" event instead of N field diffs.
 */
export async function appendTaskEngineAudit(
  taskName: string,
  field: string,
  oldValue: string | null,
  newValue: string | null,
  action: TaskEngineAuditAction,
  changedBy: string,
): Promise<void> {
  await dbRun(
    `INSERT INTO task_engine_audit (task_name, field, old_value, new_value, action, changed_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [taskName, field, oldValue, newValue, action, changedBy],
  )
}

/**
 * Idempotently insert any default tasks that are not already in the
 * DB. Called at corn-api boot so a fresh deploy ends up with the seed
 * rows even if the migration was applied to an already-populated DB
 * via the schema mirror path (where INSERT OR IGNORE in the schema
 * file does NOT execute — schema.sql contains DDL only).
 */
export async function seedDefaultTaskEngines(): Promise<{ inserted: string[] }> {
  const inserted: string[] = []
  for (const spec of DEFAULT_TASK_ENGINES) {
    const existing = await dbGet(
      'SELECT task_name FROM task_engine_config WHERE task_name = ?',
      [spec.taskName],
    )
    if (existing) continue
    await dbRun(
      `INSERT INTO task_engine_config (task_name, engine, description, model, max_output_tokens)
       VALUES (?, 'heuristic', ?, ?, ?)`,
      [
        spec.taskName,
        spec.description,
        spec.suggestedModel ?? null,
        spec.maxOutputTokens ?? 1024,
      ],
    )
    inserted.push(spec.taskName)
  }
  return { inserted }
}
