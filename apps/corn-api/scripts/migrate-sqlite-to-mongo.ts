// Phase 4 — one-shot SQLite → MongoDB data migration.
//
// Reads `corn.db` (sql.js, read-only — never writes back to the source) and
// upserts every row into the matching Mongoose collection. Idempotent: every
// row is written via `bulkWrite([{ updateOne: { filter:{_id}, update,
// upsert:true } }])` so re-runs converge instead of duplicating.
//
// Usage (HOST shell — NOT inside the corn-api container):
//
//   DATABASE_PATH=infra/api-data/corn.db \
//   MONGODB_URI="mongodb://cornhub:***@127.0.0.1:27017/cornhub?authSource=admin&replicaSet=rs0" \
//   pnpm --filter @corn/corn-api migrate:sqlite-to-mongo
//
// Order of operations (caller's responsibility per Phase 5):
//   1. `pnpm init-mongo`                    → schema sync + bootstrap singletons
//   2. `pnpm migrate:sqlite-to-mongo`        → this script (idempotent)
//   3. flip `DATABASE_DRIVER=sqlite` → `mongo` in infra/.env
//
// Conversions applied per row:
//   - INTEGER 0/1 (stored as 0/1) → Boolean (per BOOLEAN_FIELDS map)
//   - TEXT ISO timestamps         → Date (UTC-normalized via parseSqlTs)
//   - TEXT JSON                   → parsed & key-sanitized object
//                                   (`.` → `\u002e`, `$` → `\u0024` per plan §11.2)
//   - INTEGER AUTOINCREMENT id    → preserved as `_id: Number` for 6 tables
//   - composite PK (agent_ack)    → synthetic `_id = "<agent>::<project>"`
//   - encrypted provider keys     → bit-for-bit preserved (TEXT base64) so
//                                   the master key still decrypts post-cutover
//                                   (plan §6.1 HIGH RISK).
//
// Cascade middleware concern (plan §6.6):
//   bulkWrite + updateOne does NOT trigger document `pre('deleteOne')` middleware,
//   so this script will not accidentally fan out cascading deletes during ingest.

import initSqlJs, { type Database, type SqlValue } from 'sql.js'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { connectMongoose, disconnectMongoose } from '../src/db/mongoose/connection.js'
import {
  AgentAck,
  AgentMemory,
  ApiKey,
  ChangeEvent,
  CodeEdge,
  CodeSymbol,
  EmailOtp,
  IndexJob,
  KnowledgeChunk,
  KnowledgeDocument,
  LlmGatewayLog,
  ModelRouting,
  Organization,
  Project,
  ProviderAccount,
  QualityReport,
  QueryLog,
  SessionHandoff,
  SetupStatus,
  SystemSetting,
  SystemSettingAudit,
  TaskEngineAudit,
  TaskEngineConfig,
  UsageLog,
  User,
  agentAckId,
} from '../src/db/mongoose/index.js'

// ── Helpers ──────────────────────────────────────────────

const BATCH_SIZE = 500

interface SqliteRow {
  [k: string]: SqlValue | undefined
}

interface CountReport {
  collection: string
  source: number
  upserted: number
  failed: number
}

/**
 * SQLite stores `datetime('now')` as `YYYY-MM-DD HH:MM:SS` with NO trailing
 * `Z`. Treat that as UTC so post-cutover comparisons against Mongoose's
 * BSON Date are consistent.
 */
function parseSqlTs(text: string | null | undefined): Date | null {
  if (text === null || text === undefined) return null
  if (typeof text !== 'string') return null
  if (!text.trim()) return null
  const normalized = text.includes('T') ? text : text.replace(' ', 'T')
  const withZ = normalized.endsWith('Z') ? normalized : normalized + 'Z'
  const d = new Date(withZ)
  return Number.isNaN(d.getTime()) ? null : d
}

/** SQLite TEXT JSON columns can be null/empty/'null'. Parse defensively. */
function parseJson<T = unknown>(text: SqlValue | undefined, fallback: T): T {
  if (text === null || text === undefined) return fallback
  if (typeof text !== 'string') return fallback
  if (!text.trim()) return fallback
  try {
    const parsed = JSON.parse(text) as unknown
    return (parsed === null ? fallback : (parsed as T))
  } catch {
    return fallback
  }
}

/** INTEGER 0/1 column → JavaScript boolean. Anything truthy → true. */
function toBool(val: SqlValue | undefined): boolean {
  if (val === null || val === undefined) return false
  if (typeof val === 'number') return val !== 0
  if (typeof val === 'bigint') return val !== 0n
  if (typeof val === 'string') return val === '1' || val.toLowerCase() === 'true'
  return Boolean(val)
}

/** Recursively replace `.` and `$` in object keys (plan §11.2). */
function sanitizeJsonForMongo(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sanitizeJsonForMongo)
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const safeKey = k.replace(/\./g, '\u002e').replace(/^\$/, '\u0024')
      out[safeKey] = sanitizeJsonForMongo(v)
    }
    return out
  }
  return obj
}

/** Parse JSON then sanitize keys for Mongo path syntax. */
function parseJsonForMongo<T = unknown>(text: SqlValue | undefined, fallback: T): T {
  return sanitizeJsonForMongo(parseJson(text, fallback)) as T
}

function asString(v: SqlValue | undefined): string | null {
  if (v === null || v === undefined) return null
  return String(v)
}

function asNumber(v: SqlValue | undefined, fallback = 0): number {
  if (v === null || v === undefined) return fallback
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isNaN(n) ? fallback : n
  }
  return fallback
}

/** Read all rows from a SQLite table. Empty if the table doesn't exist. */
function readAll(db: Database, table: string): SqliteRow[] {
  // Guard: if the table doesn't exist (older snapshot), return empty.
  const probe = db.exec(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    [table],
  )
  if (probe.length === 0 || probe[0]!.values.length === 0) return []

  const result = db.exec(`SELECT * FROM ${table}`)
  if (result.length === 0) return []
  const { columns, values } = result[0]!
  return values.map((row) => {
    const obj: SqliteRow = {}
    columns.forEach((col, i) => {
      obj[col] = row[i] ?? null
    })
    return obj
  })
}

interface BulkOp<T> {
  updateOne: {
    filter: Record<string, unknown>
    update: { $set: T }
    upsert: true
  }
}

/**
 * Generic bulk upsert helper. Splits the input into BATCH_SIZE chunks so a
 * 100k-row migration does not blow past Mongo's `bulkWrite` payload cap.
 *
 * The model is typed as `any` because each call site already builds a
 * properly-shaped doc; flowing the per-collection generics through the
 * Mongoose 9 strict generics here would add noise without catching real bugs.
 */
async function bulkUpsert<T extends { _id: unknown }>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Model: any,
  rows: T[],
  collection: string,
): Promise<{ upserted: number; failed: number }> {
  let upserted = 0
  let failed = 0
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE)
    const ops: BulkOp<T>[] = slice.map((doc) => ({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: doc },
        upsert: true,
      },
    }))
    try {
      const res = await Model.bulkWrite(ops, { ordered: false })
      upserted +=
        (res?.upsertedCount ?? 0) +
        (res?.modifiedCount ?? 0) +
        (res?.matchedCount ?? 0)
    } catch (err) {
      failed += slice.length
      console.error(`[migrate] bulkWrite failed for ${collection} batch starting at ${i}:`, err)
    }
  }
  return { upserted, failed }
}

// ── Per-collection mappers ───────────────────────────────
//
// Each mapper returns a fully-typed Mongoose-shaped doc for a single SQLite
// row. NULLable fields become explicit `null` so Mongo doesn't drop them.

function mapSetupStatus(r: SqliteRow): { _id: string; completed: boolean; completed_at: Date | null; created_at: Date } {
  // SQLite has `id INTEGER DEFAULT 1`; Mongo singleton uses `_id: 'singleton'`.
  return {
    _id: 'singleton',
    completed: toBool(r['completed']),
    completed_at: parseSqlTs(asString(r['completed_at'])),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
  }
}

function mapUser(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asString(r['id']),
    email: asString(r['email']),
    password_hash: asString(r['password_hash']),
    name: asString(r['name']),
    role: asString(r['role']) || 'user',
    is_active: toBool(r['is_active']),
    email_verified: toBool(r['email_verified']),
    google_id: asString(r['google_id']),
    avatar_url: asString(r['avatar_url']),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
    updated_at: parseSqlTs(asString(r['updated_at'])) ?? new Date(),
  }
}

function mapEmailOtp(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asString(r['id']),
    user_id: asString(r['user_id']),
    otp_hash: asString(r['otp_hash']),
    expires_at: parseSqlTs(asString(r['expires_at'])),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
  }
}

function mapApiKey(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asString(r['id']),
    name: asString(r['name']),
    key_hash: asString(r['key_hash']),
    scope: asString(r['scope']) || 'all',
    permissions: parseJsonForMongo(r['permissions'], null),
    project_id: asString(r['project_id']),
    user_id: asString(r['user_id']),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
    expires_at: parseSqlTs(asString(r['expires_at'])),
    last_used_at: parseSqlTs(asString(r['last_used_at'])),
  }
}

function mapProviderAccount(r: SqliteRow): Record<string, unknown> {
  // CRITICAL (plan §6.1): keep the encrypted base64 string bit-for-bit so the
  // master key still decrypts after cutover. Do NOT decode/re-encode here.
  return {
    _id: asString(r['id']),
    name: asString(r['name']),
    type: asString(r['type']),
    auth_type: asString(r['auth_type']) || 'api_key',
    api_base: asString(r['api_base']),
    api_key: asString(r['api_key']),
    api_key_encrypted: toBool(r['api_key_encrypted']),
    status: asString(r['status']) || 'enabled',
    capabilities: parseJsonForMongo(r['capabilities'], ['chat']),
    models: parseJsonForMongo(r['models'], []),
    user_id: asString(r['user_id']),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
    updated_at: parseSqlTs(asString(r['updated_at'])) ?? new Date(),
  }
}

function mapOrganization(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asString(r['id']),
    name: asString(r['name']),
    slug: asString(r['slug']),
    description: asString(r['description']),
    user_id: asString(r['user_id']),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
    updated_at: parseSqlTs(asString(r['updated_at'])) ?? new Date(),
  }
}

function mapProject(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asString(r['id']),
    org_id: asString(r['org_id']),
    name: asString(r['name']),
    slug: asString(r['slug']),
    description: asString(r['description']),
    git_repo_url: asString(r['git_repo_url']),
    git_provider: asString(r['git_provider']),
    indexed_at: parseSqlTs(asString(r['indexed_at'])),
    indexed_symbols: asNumber(r['indexed_symbols']),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
    updated_at: parseSqlTs(asString(r['updated_at'])) ?? new Date(),
  }
}

function mapSystemSetting(r: SqliteRow): Record<string, unknown> {
  // `key` may contain `.` (e.g. `auth.session_timeout`) — Mongo paths reserve
  // `.`, but here it's used as a top-level `_id` STRING, not a path. _id values
  // are stored as opaque strings, so keep verbatim. (Plan §3.4 cảnh báo
  // applies to embedded keys, not top-level _id.)
  return {
    _id: asString(r['key']),
    value: asString(r['value']),
    is_secret: toBool(r['is_secret']),
    category: asString(r['category']) || 'general',
    description: asString(r['description']),
    default_value: asString(r['default_value']),
    updated_by: asString(r['updated_by']),
    updated_at: parseSqlTs(asString(r['updated_at'])) ?? new Date(),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
  }
}

function mapSystemSettingAudit(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asNumber(r['id']),
    key: asString(r['key']),
    old_value: asString(r['old_value']),
    new_value: asString(r['new_value']),
    action: asString(r['action']) || 'update',
    changed_by: asString(r['changed_by']),
    changed_at: parseSqlTs(asString(r['changed_at'])) ?? new Date(),
  }
}

function mapTaskEngineConfig(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asString(r['task_name']),
    engine: asString(r['engine']) || 'heuristic',
    provider_id: asString(r['provider_id']),
    model: asString(r['model']),
    enabled: toBool(r['enabled']),
    fallback_to_heuristic: toBool(r['fallback_to_heuristic']),
    prompt_template: asString(r['prompt_template']),
    timeout_ms: asNumber(r['timeout_ms']),
    max_input_tokens: asNumber(r['max_input_tokens']),
    max_output_tokens: asNumber(r['max_output_tokens']),
    temperature: asNumber(r['temperature']),
    cache_ttl_sec: asNumber(r['cache_ttl_sec']),
    cost_cap_usd_per_day: asNumber(r['cost_cap_usd_per_day']),
    description: asString(r['description']),
    updated_by: asString(r['updated_by']),
    updated_at: parseSqlTs(asString(r['updated_at'])) ?? new Date(),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
  }
}

function mapTaskEngineAudit(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asNumber(r['id']),
    task_name: asString(r['task_name']),
    field: asString(r['field']),
    old_value: asString(r['old_value']),
    new_value: asString(r['new_value']),
    action: asString(r['action']) || 'update',
    changed_by: asString(r['changed_by']),
    changed_at: parseSqlTs(asString(r['changed_at'])) ?? new Date(),
  }
}

function mapModelRouting(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asString(r['purpose']),
    chain: parseJsonForMongo(r['chain'], []),
    updated_at: parseSqlTs(asString(r['updated_at'])) ?? new Date(),
  }
}

function mapSessionHandoff(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asString(r['id']),
    from_agent: asString(r['from_agent']),
    to_agent: asString(r['to_agent']),
    project: asString(r['project']),
    task_summary: asString(r['task_summary']),
    context: parseJsonForMongo(r['context'], {}),
    priority: asNumber(r['priority'], 5),
    status: asString(r['status']) || 'pending',
    claimed_by: asString(r['claimed_by']),
    project_id: asString(r['project_id']),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
    last_activity_at: parseSqlTs(asString(r['last_activity_at'])) ?? new Date(),
    expires_at: parseSqlTs(asString(r['expires_at'])),
  }
}

function mapAgentAck(r: SqliteRow): Record<string, unknown> {
  // Composite PK (agent_id, project_id) → synthetic `_id = "<agent>::<project>"`.
  const agent = asString(r['agent_id']) ?? ''
  const proj = asString(r['project_id']) ?? ''
  return {
    _id: agentAckId(agent, proj),
    agent_id: agent,
    project_id: proj,
    last_seen_event_id: asString(r['last_seen_event_id']),
    updated_at: parseSqlTs(asString(r['updated_at'])) ?? new Date(),
  }
}

function mapIndexJob(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asString(r['id']),
    project_id: asString(r['project_id']),
    branch: asString(r['branch']) || 'main',
    status: asString(r['status']) || 'pending',
    progress: asNumber(r['progress']),
    total_files: asNumber(r['total_files']),
    symbols_found: asNumber(r['symbols_found']),
    log: asString(r['log']),
    error: asString(r['error']),
    commit_hash: asString(r['commit_hash']),
    commit_message: asString(r['commit_message']),
    triggered_by: asString(r['triggered_by']) || 'manual',
    mem9_status: asString(r['mem9_status']),
    mem9_chunks: asNumber(r['mem9_chunks']),
    mem9_progress: asNumber(r['mem9_progress']),
    mem9_total_chunks: asNumber(r['mem9_total_chunks']),
    docs_knowledge_status: asString(r['docs_knowledge_status']),
    docs_knowledge_count: asNumber(r['docs_knowledge_count']),
    started_at: parseSqlTs(asString(r['started_at'])),
    completed_at: parseSqlTs(asString(r['completed_at'])),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
  }
}

function mapChangeEvent(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asString(r['id']),
    project_id: asString(r['project_id']),
    branch: asString(r['branch']),
    agent_id: asString(r['agent_id']),
    commit_sha: asString(r['commit_sha']),
    commit_message: asString(r['commit_message']),
    files_changed: parseJsonForMongo(r['files_changed'], []),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
  }
}

function mapCodeSymbol(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asString(r['id']),
    project_id: asString(r['project_id']),
    name: asString(r['name']),
    kind: asString(r['kind']),
    file_path: asString(r['file_path']),
    start_line: asNumber(r['start_line']),
    end_line: asNumber(r['end_line']),
    exported: toBool(r['exported']),
    signature: asString(r['signature']),
    doc_comment: asString(r['doc_comment']),
    parent_symbol_id: asString(r['parent_symbol_id']),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
  }
}

function mapCodeEdge(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asNumber(r['id']),
    project_id: asString(r['project_id']),
    source_symbol_id: asString(r['source_symbol_id']),
    target_symbol_id: asString(r['target_symbol_id']),
    kind: asString(r['kind']),
    file_path: asString(r['file_path']),
    line_number: r['line_number'] === null || r['line_number'] === undefined ? null : asNumber(r['line_number']),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
  }
}

function mapKnowledgeDocument(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asString(r['id']),
    title: asString(r['title']),
    source: asString(r['source']) || 'manual',
    source_agent_id: asString(r['source_agent_id']),
    project_id: asString(r['project_id']),
    tags: parseJsonForMongo(r['tags'], []),
    status: asString(r['status']) || 'active',
    hit_count: asNumber(r['hit_count']),
    chunk_count: asNumber(r['chunk_count']),
    content_preview: asString(r['content_preview']),
    user_id: asString(r['user_id']),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
    updated_at: parseSqlTs(asString(r['updated_at'])) ?? new Date(),
  }
}

function mapKnowledgeChunk(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asString(r['id']),
    document_id: asString(r['document_id']),
    chunk_index: asNumber(r['chunk_index']),
    content: asString(r['content']),
    char_count: asNumber(r['char_count']),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
  }
}

function mapAgentMemory(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asString(r['id']),
    content: asString(r['content']),
    content_preview: asString(r['content_preview']),
    agent_id: asString(r['agent_id']),
    project_id: asString(r['project_id']),
    branch: asString(r['branch']),
    tags: parseJsonForMongo(r['tags'], []),
    user_id: asString(r['user_id']),
    hit_count: asNumber(r['hit_count']),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
  }
}

function mapQueryLog(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asNumber(r['id']),
    agent_id: asString(r['agent_id']),
    tool: asString(r['tool']),
    params: parseJsonForMongo(r['params'], null),
    latency_ms: r['latency_ms'] === null || r['latency_ms'] === undefined ? null : asNumber(r['latency_ms']),
    status: asString(r['status']) || 'ok',
    error: asString(r['error']),
    project_id: asString(r['project_id']),
    input_size: asNumber(r['input_size']),
    output_size: asNumber(r['output_size']),
    compute_tokens: asNumber(r['compute_tokens']),
    tokens_saved: asNumber(r['tokens_saved']),
    compute_model: asString(r['compute_model']),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
  }
}

function mapUsageLog(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asNumber(r['id']),
    agent_id: asString(r['agent_id']),
    model: asString(r['model']),
    prompt_tokens: asNumber(r['prompt_tokens']),
    completion_tokens: asNumber(r['completion_tokens']),
    total_tokens: asNumber(r['total_tokens']),
    project_id: asString(r['project_id']),
    request_type: asString(r['request_type']) || 'chat',
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
  }
}

function mapLlmGatewayLog(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asNumber(r['id']),
    task_name: asString(r['task_name']),
    provider_id: asString(r['provider_id']),
    provider: asString(r['provider']),
    model: asString(r['model']),
    input_tokens: asNumber(r['input_tokens']),
    output_tokens: asNumber(r['output_tokens']),
    cost_usd: asNumber(r['cost_usd']),
    latency_ms: asNumber(r['latency_ms']),
    cached: toBool(r['cached']),
    error: asString(r['error']),
    user_id: asString(r['user_id']),
    session_id: asString(r['session_id']),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
  }
}

function mapQualityReport(r: SqliteRow): Record<string, unknown> {
  return {
    _id: asString(r['id']),
    project_id: asString(r['project_id']),
    agent_id: asString(r['agent_id']),
    session_id: asString(r['session_id']),
    gate_name: asString(r['gate_name']),
    score_build: asNumber(r['score_build']),
    score_regression: asNumber(r['score_regression']),
    score_standards: asNumber(r['score_standards']),
    score_traceability: asNumber(r['score_traceability']),
    score_total: asNumber(r['score_total']),
    grade: asString(r['grade']) || 'F',
    passed: toBool(r['passed']),
    details: parseJsonForMongo(r['details'], null),
    user_id: asString(r['user_id']),
    created_at: parseSqlTs(asString(r['created_at'])) ?? new Date(),
  }
}

// ── Migration plan (tier order) ──────────────────────────

interface CollectionDef {
  table: string
  collection: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Model: any
  map: (r: SqliteRow) => Record<string, unknown>
}

// Tier order matches plan §11.14 — ensures referenced parents exist before
// children are upserted (in case validators / app-level checks ever add FK
// guards; right now Mongoose itself doesn't enforce FK).
const PLAN: CollectionDef[] = [
  // Tier 1 — no FK deps
  { table: 'setup_status',         collection: 'setup_status',         Model: SetupStatus,         map: mapSetupStatus },
  { table: 'users',                collection: 'users',                Model: User,                map: mapUser },
  { table: 'organizations',        collection: 'organizations',        Model: Organization,        map: mapOrganization },
  { table: 'system_settings',      collection: 'system_settings',      Model: SystemSetting,       map: mapSystemSetting },
  { table: 'task_engine_config',   collection: 'task_engine_config',   Model: TaskEngineConfig,    map: mapTaskEngineConfig },
  { table: 'model_routing',        collection: 'model_routing',        Model: ModelRouting,        map: mapModelRouting },
  // Tier 2 — depend on Tier 1
  { table: 'email_otps',           collection: 'email_otps',           Model: EmailOtp,            map: mapEmailOtp },
  { table: 'api_keys',             collection: 'api_keys',             Model: ApiKey,              map: mapApiKey },
  { table: 'provider_accounts',    collection: 'provider_accounts',    Model: ProviderAccount,     map: mapProviderAccount },
  { table: 'projects',             collection: 'projects',             Model: Project,             map: mapProject },
  { table: 'system_settings_audit', collection: 'system_settings_audit', Model: SystemSettingAudit, map: mapSystemSettingAudit },
  { table: 'task_engine_audit',    collection: 'task_engine_audit',    Model: TaskEngineAudit,     map: mapTaskEngineAudit },
  // Tier 3 — depend on Project
  { table: 'session_handoffs',     collection: 'session_handoffs',     Model: SessionHandoff,      map: mapSessionHandoff },
  { table: 'agent_ack',            collection: 'agent_ack',            Model: AgentAck,            map: mapAgentAck },
  { table: 'index_jobs',           collection: 'index_jobs',           Model: IndexJob,            map: mapIndexJob },
  { table: 'change_events',        collection: 'change_events',        Model: ChangeEvent,         map: mapChangeEvent },
  { table: 'code_symbols',         collection: 'code_symbols',         Model: CodeSymbol,          map: mapCodeSymbol },
  { table: 'knowledge_documents',  collection: 'knowledge_documents',  Model: KnowledgeDocument,   map: mapKnowledgeDocument },
  // Tier 4 — depend on Tier 3
  { table: 'code_edges',           collection: 'code_edges',           Model: CodeEdge,            map: mapCodeEdge },
  { table: 'knowledge_chunks',     collection: 'knowledge_chunks',     Model: KnowledgeChunk,      map: mapKnowledgeChunk },
  // Tier 5 — independent logs + reports
  { table: 'agent_memories',       collection: 'agent_memories',       Model: AgentMemory,         map: mapAgentMemory },
  { table: 'query_logs',           collection: 'query_logs',           Model: QueryLog,            map: mapQueryLog },
  { table: 'usage_logs',           collection: 'usage_logs',           Model: UsageLog,            map: mapUsageLog },
  { table: 'llm_gateway_logs',     collection: 'llm_gateway_logs',     Model: LlmGatewayLog,       map: mapLlmGatewayLog },
  { table: 'quality_reports',      collection: 'quality_reports',      Model: QualityReport,       map: mapQualityReport },
]

// ── Main ─────────────────────────────────────────────────

async function loadSqlite(path: string): Promise<Database> {
  if (!existsSync(path)) {
    throw new Error(`SQLite source not found: ${path}`)
  }
  const buffer = readFileSync(path)
  const SQL = await initSqlJs()
  // Read-only: we never call db.run() on this Database, so the source file
  // is never written back.
  return new SQL.Database(buffer)
}

async function main(): Promise<void> {
  const sqlitePath = resolve(process.env['DATABASE_PATH'] || './data/corn.db')
  const mongoUri = process.env['MONGODB_URI']
  if (!mongoUri) {
    console.error('[migrate] MONGODB_URI is required')
    process.exit(1)
  }

  console.log('[migrate] starting SQLite → MongoDB migration')
  console.log(`  source : ${sqlitePath}`)
  console.log(`  target : ${mongoUri.replace(/:\/\/[^@]+@/, '://***@')}`)

  const sqlite = await loadSqlite(sqlitePath)
  await connectMongoose(mongoUri)

  let totalSource = 0
  let totalUpserted = 0
  let totalFailed = 0
  const reports: CountReport[] = []

  for (const def of PLAN) {
    const rows = readAll(sqlite, def.table)
    if (rows.length === 0) {
      console.log(`[migrate] processing collection "${def.collection}" — 0 rows`)
      reports.push({ collection: def.collection, source: 0, upserted: 0, failed: 0 })
      continue
    }

    console.log(`[migrate] processing collection "${def.collection}" — ${rows.length} rows`)
    const docs = rows
      .map((r) => def.map(r))
      // Skip rows whose `_id` couldn't be derived. Belt-and-suspenders for
      // legacy fixtures with NULL id columns; a dropped row will surface in
      // the count diff at the end.
      .filter((d): d is Record<string, unknown> & { _id: unknown } =>
        d._id !== null && d._id !== undefined && d._id !== '',
      )

    const { upserted, failed } = await bulkUpsert(def.Model, docs as Array<{ _id: unknown }>, def.collection)

    totalSource += rows.length
    totalUpserted += upserted
    totalFailed += failed

    reports.push({
      collection: def.collection,
      source: rows.length,
      upserted,
      failed,
    })
  }

  // Optional verification: counts in Mongo per collection. Not strictly
  // == source rows (existing rows from a prior run also count) but useful
  // to spot wildly mismatched collections.
  console.log('\n[migrate] verification (Mongo counts):')
  for (const def of PLAN) {
    try {
      const cnt = await def.Model.countDocuments()
      const r = reports.find((x) => x.collection === def.collection)
      const src = r?.source ?? 0
      const flag = cnt < src ? ' ⚠ mongo<source' : ''
      console.log(`  ${def.collection.padEnd(28)} src=${String(src).padStart(7)}  mongo=${String(cnt).padStart(7)}${flag}`)
    } catch (err) {
      console.error(`  ${def.collection}: count failed:`, err)
    }
  }

  sqlite.close()
  await disconnectMongoose()

  console.log('\n[migrate] done')
  console.log(`  collections : ${PLAN.length}`)
  console.log(`  total       : ${totalSource}`)
  console.log(`  upserted    : ${totalUpserted}`)
  console.log(`  failed      : ${totalFailed}`)

  if (totalFailed > 0) {
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err)
  process.exitCode = 1
})
