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

import { TaskEngineConfig as TaskEngineConfigModel, TaskEngineAudit } from '../db/mongoose/index.js'

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
  const docs: Array<{
    task_name: string
    field: string
    old_value: string | null
    new_value: string | null
    action: 'update'
    changed_by: string
  }> = []
  for (const field of AUDIT_FIELDS) {
    const oldStr = toAuditValue(before ? before[field] : null)
    const newStr = toAuditValue(after[field])
    if (oldStr === newStr) continue
    docs.push({
      task_name: taskName,
      field,
      old_value: oldStr,
      new_value: newStr,
      action: 'update',
      changed_by: changedBy,
    })
  }
  if (docs.length > 0) {
    await TaskEngineAudit.insertMany(docs as Parameters<typeof TaskEngineAudit.insertMany>[0])
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

// ── Doc → typed config ──────────────────────────────────

interface DbDoc {
  _id: string
  engine?: string
  provider_id?: string | null
  model?: string | null
  enabled?: boolean
  fallback_to_heuristic?: boolean
  prompt_template?: string | null
  timeout_ms?: number
  max_input_tokens?: number
  max_output_tokens?: number
  temperature?: number
  cache_ttl_sec?: number
  cost_cap_usd_per_day?: number
  description?: string | null
  updated_by?: string | null
  updated_at?: Date | string
}

function docToConfig(doc: DbDoc): TaskEngineConfig {
  return {
    task_name: doc._id,
    engine: doc.engine === 'llm' ? 'llm' : 'heuristic',
    provider_id: doc.provider_id ?? null,
    model: doc.model ?? null,
    enabled: doc.enabled === false ? 0 : 1,
    fallback_to_heuristic: doc.fallback_to_heuristic === false ? 0 : 1,
    prompt_template: doc.prompt_template ?? null,
    timeout_ms: Number(doc.timeout_ms ?? 30_000),
    max_input_tokens: Number(doc.max_input_tokens ?? 8000),
    max_output_tokens: Number(doc.max_output_tokens ?? 1024),
    temperature: Number(doc.temperature ?? 0.2),
    cache_ttl_sec: Number(doc.cache_ttl_sec ?? 3600),
    cost_cap_usd_per_day: Number(doc.cost_cap_usd_per_day ?? 0),
    description: doc.description ?? null,
    updated_by: doc.updated_by ?? null,
    updated_at: doc.updated_at ? new Date(doc.updated_at).toISOString() : '',
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

// Audit `id` field used to be a SQL INTEGER AUTOINCREMENT; we coerce
// the Mongo `_id` (Number for migrated rows, ObjectId for new ones)
// into a stable number so existing dashboard URLs keep working.
function coerceAuditId(id: unknown): number {
  if (typeof id === 'number') return id
  // FNV-1a hash of the ObjectId hex — stable across runs, fits 32-bit.
  let h = 0x811c9dc5
  const s = String(id)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
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

  const doc = await TaskEngineConfigModel.findById(taskName).lean<DbDoc | null>()
  const value = doc ? docToConfig(doc) : null
  cache.set(taskName, { value, expiresAt: now + ttlMs() })
  return value ?? defaultConfigFor(taskName)
}

/**
 * List all task configs. Merges DB rows with the default seed so the
 * admin UI sees every known task even before migration runs (or when
 * an admin reset the table).
 */
export async function listTaskEngineConfigs(): Promise<TaskEngineConfig[]> {
  const docs = await TaskEngineConfigModel.find({}).sort({ _id: 1 }).lean<DbDoc[]>()
  const byName = new Map<string, TaskEngineConfig>()
  for (const doc of docs) {
    const cfg = docToConfig(doc)
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

  const existing = await TaskEngineConfigModel.findById(taskName).lean<DbDoc | null>()

  // Build the merged row using either the existing DB values or the
  // hardcoded defaults so a brand-new task gets sane numbers without
  // the admin having to fill every field. We diff against the existing
  // row (or null = creation) for audit so the UI shows actual admin
  // intent — e.g. "engine: heuristic → llm" not "engine: → llm" on
  // first edit.
  const fallback = defaultConfigFor(taskName)
  const merged = {
    engine: patch.engine ?? (existing?.engine === 'llm' ? 'llm' : existing?.engine === 'heuristic' ? 'heuristic' : fallback.engine),
    provider_id:
      patch.providerId === undefined
        ? (existing?.provider_id ?? fallback.provider_id)
        : patch.providerId,
    model:
      patch.model === undefined
        ? (existing?.model ?? fallback.model)
        : patch.model,
    enabled:
      patch.enabled === undefined
        ? (existing?.enabled === false ? 0 : 1)
        : patch.enabled
        ? 1
        : 0,
    fallback_to_heuristic:
      patch.fallbackToHeuristic === undefined
        ? (existing?.fallback_to_heuristic === false ? 0 : 1)
        : patch.fallbackToHeuristic
        ? 1
        : 0,
    prompt_template:
      patch.promptTemplate === undefined
        ? (existing?.prompt_template ?? fallback.prompt_template)
        : patch.promptTemplate,
    timeout_ms: patch.timeoutMs ?? Number(existing?.timeout_ms ?? fallback.timeout_ms),
    max_input_tokens:
      patch.maxInputTokens ?? Number(existing?.max_input_tokens ?? fallback.max_input_tokens),
    max_output_tokens:
      patch.maxOutputTokens ?? Number(existing?.max_output_tokens ?? fallback.max_output_tokens),
    temperature: patch.temperature ?? Number(existing?.temperature ?? fallback.temperature),
    cache_ttl_sec:
      patch.cacheTtlSec ?? Number(existing?.cache_ttl_sec ?? fallback.cache_ttl_sec),
    cost_cap_usd_per_day:
      patch.costCapUsdPerDay ??
      Number(existing?.cost_cap_usd_per_day ?? fallback.cost_cap_usd_per_day),
    description:
      patch.description === undefined
        ? (existing?.description ?? fallback.description)
        : patch.description,
  }

  await TaskEngineConfigModel.findOneAndUpdate(
    { _id: taskName },
    {
      $set: {
        engine: merged.engine,
        provider_id: merged.provider_id,
        model: merged.model,
        // Schema stores booleans; legacy SQL had 0/1 ints.
        enabled: merged.enabled === 1,
        fallback_to_heuristic: merged.fallback_to_heuristic === 1,
        prompt_template: merged.prompt_template,
        timeout_ms: merged.timeout_ms,
        max_input_tokens: merged.max_input_tokens,
        max_output_tokens: merged.max_output_tokens,
        temperature: merged.temperature,
        cache_ttl_sec: merged.cache_ttl_sec,
        cost_cap_usd_per_day: merged.cost_cap_usd_per_day,
        description: merged.description,
        updated_by: patch.updatedBy ?? 'system',
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  )

  // Append per-field audit rows AFTER the write succeeds. Audit `enabled`
  // and `fallback_to_heuristic` as 0/1 strings to match the legacy SQL
  // contract (SQLite INTEGER columns produced '0'/'1' strings).
  const beforeForAudit: Record<string, unknown> | null = existing
    ? {
        ...existing,
        enabled: existing.enabled === false ? 0 : 1,
        fallback_to_heuristic: existing.fallback_to_heuristic === false ? 0 : 1,
      }
    : null
  await recordAuditDiff(taskName, beforeForAudit, merged, patch.updatedBy ?? 'system')

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
  const filter = opts.taskName ? { task_name: opts.taskName } : {}
  const rows = await TaskEngineAudit.find(filter)
    .sort({ changed_at: -1, _id: -1 })
    .limit(limit)
    .lean()

  return rows.map((r) => ({
    id: coerceAuditId(r._id),
    task_name: r.task_name ?? '',
    field: r.field ?? '',
    old_value: r.old_value ?? null,
    new_value: r.new_value ?? null,
    action: (r.action === 'test' || r.action === 'reset' ? r.action : 'update') as TaskEngineAuditAction,
    changed_by: r.changed_by ?? null,
    changed_at: r.changed_at ? new Date(r.changed_at).toISOString() : '',
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
  await TaskEngineAudit.create({
    task_name: taskName,
    field,
    old_value: oldValue,
    new_value: newValue,
    action,
    changed_by: changedBy,
  } as Parameters<typeof TaskEngineAudit.create>[0])
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
    const existing = await TaskEngineConfigModel.findById(spec.taskName, { _id: 1 }).lean()
    if (existing) continue
    await TaskEngineConfigModel.create({
      _id: spec.taskName,
      engine: 'heuristic',
      description: spec.description,
      model: spec.suggestedModel ?? null,
      max_output_tokens: spec.maxOutputTokens ?? 1024,
    } as Parameters<typeof TaskEngineConfigModel.create>[0])
    inserted.push(spec.taskName)
  }
  return { inserted }
}
