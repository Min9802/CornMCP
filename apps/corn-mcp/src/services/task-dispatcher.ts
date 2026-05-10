// ─── Task Dispatcher (S5.2) ─────────────────────────────
// In-process registry for MCP tools that want to run an LLM in
// production but keep a deterministic heuristic fallback path. The
// canonical example is `corn_plan_quality`: heuristic = pure JS
// keyword check, LLM = chat completion that rates each criterion
// 0-10 with structured JSON output.
//
// Architecture (cross-process):
//   corn-mcp (this file)
//     ├── registerTask(name, { heuristic, llm? })
//     └── runTask(name, input)
//          ├── fetch config → GET corn-api /api/system/task-engines/:name
//          │                 (60s in-process cache, never DB-direct)
//          ├── if engine='heuristic' OR llm handler missing → run heuristic
//          └── if engine='llm':
//                ├── invoke llm handler (handler chooses model + prompt)
//                ├── handler can call `chatCompleteRemote(req, env)`
//                │   which POSTs corn-api /api/llm/chat-complete
//                └── on error:
//                      ├── fallback_to_heuristic=1 → run heuristic
//                      └── fallback_to_heuristic=0 → rethrow
//
// Why HTTP not direct: corn-api owns the encryption keys, cost cap,
// virtual env provider state, and pricing setting. Duplicating any
// of that into corn-mcp would create two sources of truth and a
// security perimeter we don't want.
//
// Cache: per-task config TTL 60s (configurable via env
// `TASK_ENGINE_CACHE_TTL_MS`), invalidated by lapse only — admin UI
// edits propagate at most 60s after PATCH. Matches settings.ts cadence.

import type { McpEnv } from '@corn/shared-types'

// Re-export under the dispatcher's vocabulary so internal callers don't
// have to know about shared-types layout. Both shapes are identical.
export type DispatcherEnv = McpEnv

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
}

export interface RunContext {
  /** The fetched config (cached) — handlers can read prompt_template, model, etc. */
  config: TaskEngineConfig
  /** Mcp env (DASHBOARD_API_URL, DASHBOARD_API_KEY, ...) for HTTP calls. */
  env: McpEnv
}

export interface TaskHandlers<I, O> {
  /** Always available. Pure function, no IO. Used for engine='heuristic' or LLM fallback. */
  heuristic: (input: I) => Promise<O> | O
  /** Optional. When config.engine='llm' the dispatcher invokes this with `chatCompleteRemote`. */
  llm?: (input: I, ctx: RunContext) => Promise<O>
}

interface RegisteredTask<I, O> extends TaskHandlers<I, O> {
  name: string
}

const registry = new Map<string, RegisteredTask<unknown, unknown>>()

/** Test-only: clear the global registry. */
export function _resetTaskRegistryForTests(): void {
  registry.clear()
}

/**
 * Register a task by name. Re-registering the same name overwrites
 * the previous handlers — useful for hot-reload in tests. Production
 * callers wire each task once at module init.
 */
export function registerTask<I, O>(
  name: string,
  handlers: TaskHandlers<I, O>,
): void {
  if (!name) throw new Error('Task name is required')
  if (typeof handlers.heuristic !== 'function') {
    throw new Error(`Task ${name}: heuristic handler is required`)
  }
  registry.set(name, { name, ...handlers } as RegisteredTask<unknown, unknown>)
}

/** Lookup a registered task. Tests use this; runTask is the entry point. */
export function getRegisteredTask(name: string): RegisteredTask<unknown, unknown> | undefined {
  return registry.get(name)
}

// ── Config cache ────────────────────────────────────────
interface CacheEntry {
  config: TaskEngineConfig
  expiresAt: number
}
const configCache = new Map<string, CacheEntry>()

function cacheTtlMs(): number {
  const env = Number(process.env['TASK_ENGINE_CACHE_TTL_MS'])
  return Number.isFinite(env) && env > 0 ? env : 60_000
}

export function _resetTaskConfigCacheForTests(): void {
  configCache.clear()
}

// ── HTTP injection seam (test hook) ─────────────────────
// Jest-style mock injection without monkey-patching globalThis. The
// production path always uses the real `fetch`. Tests call
// `_setFetchImplForTests(mockFetch)` in beforeEach + restore in
// afterEach.
let fetchImpl: typeof fetch = fetch

export function _setFetchImplForTests(impl: typeof fetch): void {
  fetchImpl = impl
}
export function _resetFetchImplForTests(): void {
  fetchImpl = fetch
}

function apiBase(env: McpEnv): string {
  return (env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')
}

function authHeaders(env: McpEnv): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.DASHBOARD_API_KEY) headers['X-API-Key'] = env.DASHBOARD_API_KEY
  return headers
}

/**
 * Fetch config for a task. Result cached per-process for ~60s. On
 * fetch error returns a synthetic heuristic config so the dispatcher
 * stays online even when corn-api is briefly unreachable.
 */
export async function fetchTaskEngineConfig(
  taskName: string,
  env: McpEnv,
): Promise<TaskEngineConfig> {
  const now = Date.now()
  const hit = configCache.get(taskName)
  if (hit && hit.expiresAt > now) return hit.config

  let config: TaskEngineConfig
  try {
    const url = `${apiBase(env)}/api/system/task-engines/${encodeURIComponent(taskName)}`
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: authHeaders(env),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      throw new Error(`task-engine fetch ${res.status}`)
    }
    const body = (await res.json()) as { config?: TaskEngineConfig }
    if (!body || !body.config) throw new Error('Invalid task-engine response')
    config = body.config
  } catch {
    // Stay online with safe defaults — heuristic always works.
    config = synthHeuristicConfig(taskName)
  }

  configCache.set(taskName, { config, expiresAt: now + cacheTtlMs() })
  return config
}

function synthHeuristicConfig(taskName: string): TaskEngineConfig {
  return {
    task_name: taskName,
    engine: 'heuristic',
    provider_id: null,
    model: null,
    enabled: 1,
    fallback_to_heuristic: 1,
    prompt_template: null,
    timeout_ms: 30_000,
    max_input_tokens: 8000,
    max_output_tokens: 1024,
    temperature: 0.2,
    cache_ttl_sec: 3600,
    cost_cap_usd_per_day: 0,
    description: null,
  }
}

// ── chatComplete remote shim ────────────────────────────

export interface RemoteChatRequest {
  model: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  providerId?: string
  provider?: 'openai' | 'anthropic' | 'gemini'
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  cacheTTLSec?: number
  taskName?: string
  userId?: string
  sessionId?: string
}

export interface RemoteChatResponse {
  content: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  latencyMs: number
  cached: boolean
  providerId: string
  provider: 'openai' | 'anthropic' | 'gemini'
  model: string
  tokensEstimated: boolean
}

export class RemoteChatError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'RemoteChatError'
  }
  /** True when the gateway already exhausted its fallback chain (provider-side errors). */
  get isProviderFailure(): boolean {
    return (
      this.code === 'provider_error' ||
      this.code === 'provider_auth' ||
      this.code === 'rate_limited' ||
      this.code === 'timeout' ||
      this.code === 'no_provider_configured'
    )
  }
  /** True when the gateway refused the call due to global cost cap. */
  get isCostCap(): boolean {
    return this.code === 'cost_cap_exceeded'
  }
}

/**
 * Cross-process bridge to the in-process `chatComplete()` in corn-api.
 * Errors come back JSON-shaped `{error, code, detail?}` and get mapped
 * into {@link RemoteChatError} so callers can `instanceof` and branch
 * on `.code` without parsing strings.
 */
export async function chatCompleteRemote(
  req: RemoteChatRequest,
  env: McpEnv,
): Promise<RemoteChatResponse> {
  const url = `${apiBase(env)}/api/llm/chat-complete`
  // Default the dispatcher's own timeout to the request's `timeoutMs`
  // plus a small grace so the gateway has room to time out a slow
  // provider before our HTTP call gives up.
  const httpTimeout = (req.timeoutMs ?? 60_000) + 5_000
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(httpTimeout),
  })

  if (!res.ok) {
    let body: { error?: string; code?: string; detail?: unknown } = {}
    try {
      body = (await res.json()) as typeof body
    } catch {
      body = { error: `HTTP ${res.status}`, code: 'unknown' }
    }
    throw new RemoteChatError(
      res.status,
      body.code ?? 'unknown',
      body.error ?? `HTTP ${res.status}`,
      body.detail,
    )
  }

  return (await res.json()) as RemoteChatResponse
}

// ── runTask ─────────────────────────────────────────────

export interface RunTaskOptions {
  /** Override the cached config — primarily for tests. */
  config?: TaskEngineConfig
}

export interface RunTaskMetadata {
  /** Engine that actually produced the result. May differ from config.engine on fallback. */
  engineUsed: TaskEngineKind
  /** True when LLM path threw and we fell back to heuristic. */
  fellBack: boolean
  /** Original error message when LLM path failed (only when fellBack=true). */
  llmError?: string
}

export interface RunTaskResult<O> {
  result: O
  metadata: RunTaskMetadata
}

/**
 * Execute the registered task with config-driven engine selection.
 *
 * Resolution order:
 *   1. Task not registered → throws (programmer error).
 *   2. config.enabled=0    → throws TaskDisabledError (admin disabled it).
 *   3. config.engine='heuristic' OR llm handler missing → heuristic path.
 *   4. config.engine='llm':
 *        4a. Try llm handler.
 *        4b. On error, if fallback_to_heuristic=1 → heuristic path
 *            (returns metadata.fellBack=true).
 *        4c. On error, if fallback_to_heuristic=0 → rethrow.
 */
export async function runTask<I, O>(
  name: string,
  input: I,
  env: McpEnv,
  opts: RunTaskOptions = {},
): Promise<RunTaskResult<O>> {
  const task = registry.get(name) as RegisteredTask<I, O> | undefined
  if (!task) {
    throw new Error(`Task '${name}' is not registered with the dispatcher`)
  }

  const config = opts.config ?? (await fetchTaskEngineConfig(name, env))

  if (!config.enabled) {
    throw new TaskDisabledError(name)
  }

  // Heuristic path — either by config or because no llm handler is wired.
  if (config.engine !== 'llm' || !task.llm) {
    const result = await Promise.resolve(task.heuristic(input))
    return { result, metadata: { engineUsed: 'heuristic', fellBack: false } }
  }

  // LLM path with optional heuristic fallback.
  try {
    const ctx: RunContext = { config, env }
    const result = await task.llm(input, ctx)
    return { result, metadata: { engineUsed: 'llm', fellBack: false } }
  } catch (err) {
    if (config.fallback_to_heuristic) {
      const result = await Promise.resolve(task.heuristic(input))
      return {
        result,
        metadata: {
          engineUsed: 'heuristic',
          fellBack: true,
          llmError: (err as Error).message ?? String(err),
        },
      }
    }
    throw err
  }
}

export class TaskDisabledError extends Error {
  constructor(public readonly taskName: string) {
    super(`Task '${taskName}' is disabled by config (enabled=0)`)
    this.name = 'TaskDisabledError'
  }
}
