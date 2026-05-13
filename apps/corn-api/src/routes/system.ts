import { Hono } from 'hono'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { jwtAuthMiddleware, getAuthCtx, anyAuthMiddleware, adminOnly } from '../middleware/auth.js'
import {
  getSetting,
  setSetting,
  listSettings,
  getSettingAudit,
  checkAndRecordRevealRateLimit,
  auditReveal,
  migrateFromEnv,
  DEFAULT_SETTINGS,
} from '../services/settings.js'
import { resolveEmbeddingConfig } from '../services/embedding-config.js'
import {
  DEFAULT_TASK_ENGINES,
  getTaskEngineConfig,
  listTaskEngineConfigs,
  updateTaskEngineConfig,
  getTaskEngineAudit,
  appendTaskEngineAudit,
  type TaskEngineUpdate,
} from '../services/task-engines.js'
import {
  chatComplete,
  type ChatRequest,
  CostCapExceededError,
  NoProviderConfiguredError,
  ProviderAuthError,
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from '../services/llm-gateway/index.js'

export const systemRouter = new Hono()

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function getCpuUsage(): { percent: number; cores: number; model: string; loadAvg: number[] } {
  const cpus = os.cpus()
  const loadAvg = os.loadavg()
  const cores = cpus.length
  const percent = Math.min(100, Math.round((loadAvg[0]! / cores) * 100))
  return {
    percent,
    cores,
    model: cpus[0]?.model ?? 'Unknown',
    loadAvg: loadAvg.map(l => Math.round(l * 100) / 100),
  }
}

function getContainerStats(): Array<{ name: string; status: string; cpu: string; memory: string }> {
  try {
    const psOutput = execFileSync('docker', [
      'ps', '-a', '--filter', 'name=corn-',
      '--format', '{{.Names}}|{{.State}}|{{.Status}}|{{.Image}}',
    ], { timeout: 5000, encoding: 'utf-8' }).trim()

    if (!psOutput) return []

    return psOutput.split('\n').filter(Boolean).map((line: string) => {
      const [name, state, status, image] = line.split('|')
      return { name: name ?? 'unknown', status: state ?? 'unknown', cpu: 'N/A', memory: status ?? '' }
    })
  } catch {
    return []
  }
}

systemRouter.get('/metrics', async (c) => {
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = totalMem - freeMem
  const memPercent = Math.round((usedMem / totalMem) * 100)

  const cpu = getCpuUsage()
  const containers = getContainerStats()

  const networkInterfaces = os.networkInterfaces()
  const primaryIp = Object.values(networkInterfaces)
    .flat()
    .find(iface => iface && !iface.internal && iface.family === 'IPv4')?.address ?? 'unknown'

  return c.json({
    timestamp: new Date().toISOString(),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptime: Math.floor(os.uptime()),
    ip: primaryIp,
    cpu: {
      percent: cpu.percent,
      cores: cpu.cores,
      model: cpu.model,
      loadAvg: cpu.loadAvg,
    },
    memory: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      percent: memPercent,
      totalHuman: formatBytes(totalMem),
      usedHuman: formatBytes(usedMem),
      freeHuman: formatBytes(freeMem),
    },
    containers,
  })
})

// ─── System Settings (S2) ────────────────────────────────
// Admin-only sub-router. Mounted under `/api/system/settings/*` so it shares
// the same prefix as `/metrics` (which intentionally stays unauthenticated
// for liveness/readiness probes). Auth is applied selectively here rather
// than at the parent router level.
const settingsSub = new Hono()
settingsSub.use('*', jwtAuthMiddleware)
settingsSub.use('*', async (c, next) => {
  const { user } = getAuthCtx(c)
  if (user.role !== 'admin') {
    return c.json({ error: 'Admin role required' }, 403)
  }
  await next()
})

// Reserved route segments that must not collide with the `:key` path param.
// Guarded explicitly because Hono's single-segment `:key` will still match
// `POST /defaults` if we're not careful and the route order regresses.
const RESERVED_KEYS = new Set(['audit', 'defaults', 'migrate-from-env'])

// S2.4 — list settings (mask secrets)
settingsSub.get('/', async (c) => {
  const category = c.req.query('category')
  const settings = await listSettings(category ? { category } : {})
  return c.json({ settings })
})

// S3.5 — default schema (17 keys). Used by the admin UI to render rows for
// keys that don't yet have a DB entry (so the user can see which knobs
// exist before running a migrate).
settingsSub.get('/defaults', (c) => {
  return c.json({ defaults: DEFAULT_SETTINGS })
})

// S3.5 — one-shot seed from process.env into DB. Idempotent.
settingsSub.post('/migrate-from-env', async (c) => {
  const { user } = getAuthCtx(c)
  const result = await migrateFromEnv(user.id)
  return c.json(result)
})

// S3.3 — reveal plaintext of a key for admin display. Always audits for
// secret keys and rate-limits per-user to make brute dumps visible.
// Registered BEFORE `/:key` so Hono's router matches the more-specific
// two-segment path first.
settingsSub.get('/:key/reveal', async (c) => {
  const key = c.req.param('key')
  const { user } = getAuthCtx(c)

  const list = await listSettings()
  const meta = list.find((s) => s.key === key)
  // Non-secret keys don't get rate-limited nor audited — plaintext is
  // already visible in the list endpoint, revealing adds no risk.
  if (!meta || meta.is_secret !== 1) {
    const value = await getSetting(key)
    return c.json({
      key,
      value,
      is_secret: false,
      source: meta?.value_set ? 'db' : value === null ? 'none' : 'env',
      rate_limit: { remaining: -1 },
    })
  }

  const gate = checkAndRecordRevealRateLimit(user.id)
  if (!gate.ok) {
    c.header('Retry-After', String(gate.retryAfterSeconds ?? 60))
    return c.json(
      {
        error: 'Reveal rate limit exceeded',
        retry_after_seconds: gate.retryAfterSeconds,
      },
      429,
    )
  }

  const value = await getSetting(key)
  if (value === null) {
    return c.json({ key, value: null, is_secret: true, source: 'none', rate_limit: { remaining: gate.remaining } })
  }

  await auditReveal(key, user.id)
  return c.json({
    key,
    value,
    is_secret: true,
    source: 'db',
    rate_limit: { remaining: gate.remaining },
  })
})

// Resolve effective value (DB > env fallback > null). Admin-only because
// it returns the *plaintext* for non-secret keys; secrets stay masked.
settingsSub.get('/:key', async (c) => {
  const key = c.req.param('key')
  if (RESERVED_KEYS.has(key)) return c.json({ error: 'Reserved path' }, 400)
  const fallbackEnv = c.req.query('fallbackEnv') || undefined
  const value = await getSetting(key, fallbackEnv)
  // Look up metadata so callers know whether this is a secret without a
  // separate round-trip; secrets are returned masked.
  const list = await listSettings()
  const meta = list.find((s) => s.key === key)
  if (!meta) {
    return c.json({ key, value, source: value === null ? 'none' : 'env', is_secret: false })
  }
  return c.json({
    key,
    value: meta.is_secret === 1 ? meta.value_masked : value,
    is_secret: meta.is_secret === 1,
    source: meta.value_set ? 'db' : value === null ? 'none' : 'env',
    metadata: meta,
  })
})

// S2.5 — upsert (audit logged). Body: { value, isSecret?, category?, description?, defaultValue? }
settingsSub.patch('/:key', async (c) => {
  const key = c.req.param('key')
  if (RESERVED_KEYS.has(key)) return c.json({ error: 'Reserved path' }, 400)
  const { user } = getAuthCtx(c)
  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const value =
    body['value'] === null || body['value'] === undefined
      ? null
      : String(body['value'])

  await setSetting(key, value, {
    isSecret: typeof body['isSecret'] === 'boolean' ? (body['isSecret'] as boolean) : undefined,
    category: typeof body['category'] === 'string' ? (body['category'] as string) : undefined,
    description: typeof body['description'] === 'string' ? (body['description'] as string) : undefined,
    defaultValue:
      typeof body['defaultValue'] === 'string' ? (body['defaultValue'] as string) : undefined,
    updatedBy: user.id,
  })

  return c.json({ ok: true })
})

// S2.6 — last `limit` audit entries for a key
settingsSub.get('/audit/:key', async (c) => {
  const key = c.req.param('key')
  const limit = Number(c.req.query('limit')) || 50
  const entries = await getSettingAudit(key, limit)
  return c.json({ entries })
})

systemRouter.route('/settings', settingsSub)

// ─── Embedding Config (MCP-facing) ──────────────────────
// Read-only endpoint mounted as a sibling of /settings/* so corn-mcp
// (authenticated by X-API-Key) can fetch the live embedding config
// without going through the admin-only JWT path.
//
// Priority per field: DB row > env var > null. Secret api_key is
// decrypted server-side via getSetting() and returned in plaintext
// over the internal HTTP boundary — callers MUST NOT log the response.
//
// Why a dedicated route instead of letting MCP hit /settings/:key:
//   1. /settings/* is admin-JWT-gated; MCP holds X-API-Key, not a JWT.
//   2. Bundles 4 reads into 1 round-trip (cold-start latency matters).
//   3. Lets the API decide what's safe to expose to non-admin callers.
systemRouter.get('/embedding-config', anyAuthMiddleware, async (c) => {
  const payload = await resolveEmbeddingConfig()
  return c.json(payload)
})

// ─── Task Engines (S5.4) ────────────────────────────────
// Two sub-routers because dispatcher (corn-mcp) needs read-only access
// with an API key while writes are admin-only. Mounting them both under
// `/task-engines` would force everything through `jwtAuthMiddleware`,
// which would break the corn-mcp lookup path.
const taskEnginesRead = new Hono()
taskEnginesRead.use('*', anyAuthMiddleware)

// Defaults: returned even when DB hasn't been seeded — UI shows row +
// "Save" creates the actual record on first edit.
taskEnginesRead.get('/defaults', (c) => {
  return c.json({ defaults: DEFAULT_TASK_ENGINES })
})

taskEnginesRead.get('/', async (c) => {
  const configs = await listTaskEngineConfigs()
  return c.json({ configs })
})

taskEnginesRead.get('/:taskName', async (c) => {
  const taskName = c.req.param('taskName')
  if (!taskName || taskName === 'defaults') return c.json({ error: 'Invalid task name' }, 400)
  const config = await getTaskEngineConfig(taskName)
  return c.json({ config })
})

const taskEnginesWrite = new Hono()
taskEnginesWrite.use('*', jwtAuthMiddleware)
taskEnginesWrite.use('*', async (c, next) => {
  const { user } = getAuthCtx(c)
  if (user.role !== 'admin') return c.json({ error: 'Admin role required' }, 403)
  await next()
})

taskEnginesWrite.patch('/:taskName', async (c) => {
  const taskName = c.req.param('taskName')
  if (!taskName) return c.json({ error: 'Task name required' }, 400)
  const { user } = getAuthCtx(c)

  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  // Whitelist fields and coerce types so callers can post strings from a
  // simple HTML form. Anything not listed is silently dropped.
  const patch: TaskEngineUpdate = { updatedBy: user.id }
  if (body['engine'] !== undefined) {
    patch.engine = body['engine'] === 'llm' ? 'llm' : 'heuristic'
  }
  if (body['providerId'] !== undefined) {
    patch.providerId =
      body['providerId'] === null || body['providerId'] === ''
        ? null
        : String(body['providerId'])
  }
  if (body['model'] !== undefined) {
    patch.model =
      body['model'] === null || body['model'] === '' ? null : String(body['model'])
  }
  if (body['enabled'] !== undefined) patch.enabled = Boolean(body['enabled'])
  if (body['fallbackToHeuristic'] !== undefined) {
    patch.fallbackToHeuristic = Boolean(body['fallbackToHeuristic'])
  }
  if (body['promptTemplate'] !== undefined) {
    patch.promptTemplate =
      body['promptTemplate'] === null || body['promptTemplate'] === ''
        ? null
        : String(body['promptTemplate'])
  }
  if (body['timeoutMs'] !== undefined) patch.timeoutMs = Number(body['timeoutMs'])
  if (body['maxInputTokens'] !== undefined) {
    patch.maxInputTokens = Number(body['maxInputTokens'])
  }
  if (body['maxOutputTokens'] !== undefined) {
    patch.maxOutputTokens = Number(body['maxOutputTokens'])
  }
  if (body['temperature'] !== undefined) patch.temperature = Number(body['temperature'])
  if (body['cacheTtlSec'] !== undefined) patch.cacheTtlSec = Number(body['cacheTtlSec'])
  if (body['costCapUsdPerDay'] !== undefined) {
    patch.costCapUsdPerDay = Number(body['costCapUsdPerDay'])
  }
  if (body['description'] !== undefined) {
    patch.description =
      body['description'] === null ? null : String(body['description'])
  }

  try {
    const config = await updateTaskEngineConfig(taskName, patch)
    return c.json({ config })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400)
  }
})

// ─── Admin-only task-engine ops (S6.1) ──────────────────
// /audit (per-task or global history) and /:taskName/test (run a sample
// prompt through the live config) live in their OWN sub-router with
// JWT+admin guards. Mounted FIRST so `/audit` resolves before
// taskEnginesRead's catch-all `/:taskName`. Without this ordering Hono
// would route GET /task-engines/audit → taskName='audit' → 400.
const taskEnginesAdmin = new Hono()
taskEnginesAdmin.use('*', jwtAuthMiddleware)
taskEnginesAdmin.use('*', adminOnly)

// Rate limit "Test" runs per-admin so an accidental loop doesn't burn
// real provider tokens. Mirrors the reveal rate limiter (S3.3) but with
// a tighter window since each test = real LLM call. In-memory Map per
// process; OK for single-replica dev.
const TEST_RATE_LIMIT = 10
const TEST_WINDOW_MS = 60 * 60 * 1000
const testCounters = new Map<string, number[]>()

function checkTestRateLimit(userId: string): { ok: true; remaining: number } | { ok: false; retryAfterSec: number } {
  const now = Date.now()
  const windowStart = now - TEST_WINDOW_MS
  const prior = testCounters.get(userId) ?? []
  const recent = prior.filter((t) => t > windowStart)
  if (recent.length >= TEST_RATE_LIMIT) {
    const oldest = recent[0] ?? now
    const retryAfterSec = Math.max(1, Math.ceil((oldest + TEST_WINDOW_MS - now) / 1000))
    testCounters.set(userId, recent)
    return { ok: false, retryAfterSec }
  }
  recent.push(now)
  testCounters.set(userId, recent)
  return { ok: true, remaining: TEST_RATE_LIMIT - recent.length }
}

// Default system prompt when admin hasn't configured `prompt_template`.
// Keep it short — admin can refine in the modal. The token `{{input}}`
// is substituted with the user-provided test input.
function renderTemplate(template: string | null, taskName: string, input: string): { system: string; user: string } {
  if (!template) {
    return {
      system: `You are an AI assistant for the task "${taskName}". Respond concisely.`,
      user: input,
    }
  }
  // If the template includes {{input}}, treat the whole thing as the
  // system prompt and put a short user message. Otherwise the template
  // IS the system prompt and `input` becomes the user message.
  if (template.includes('{{input}}')) {
    return {
      system: template.replaceAll('{{input}}', input),
      user: 'Run the task as instructed above.',
    }
  }
  return { system: template, user: input }
}

taskEnginesAdmin.get('/audit', async (c) => {
  const taskName = c.req.query('taskName') || undefined
  const limit = Number(c.req.query('limit')) || 50
  const entries = await getTaskEngineAudit({ taskName, limit })
  return c.json({ entries })
})

taskEnginesAdmin.post('/:taskName/test', async (c) => {
  const taskName = c.req.param('taskName')
  if (!taskName) return c.json({ error: 'Task name required' }, 400)
  const { user } = getAuthCtx(c)

  const gate = checkTestRateLimit(user.id)
  if (!gate.ok) {
    c.header('Retry-After', String(gate.retryAfterSec))
    return c.json(
      { error: 'Test rate limit exceeded', retry_after_seconds: gate.retryAfterSec },
      429,
    )
  }

  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const input = typeof body['input'] === 'string' ? body['input'] : ''
  if (!input.trim()) return c.json({ error: '`input` required' }, 400)

  const config = await getTaskEngineConfig(taskName)
  if (config.engine !== 'llm') {
    return c.json(
      {
        error: 'Test only valid when engine="llm". Switch the engine first or run heuristic locally.',
        engine: config.engine,
      },
      400,
    )
  }
  if (!config.model) {
    return c.json({ error: 'No model configured. Pick a model in the Configure modal first.' }, 400)
  }

  const prompt = renderTemplate(config.prompt_template, taskName, input)
  const req: ChatRequest = {
    model: config.model,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    maxTokens: config.max_output_tokens,
    temperature: config.temperature,
    timeoutMs: config.timeout_ms,
    cacheTTLSec: 0, // never cache test runs — admin wants live cost numbers
    taskName: `test:${taskName}`,
    userId: user.id,
  }
  if (config.provider_id) req.providerId = config.provider_id

  // Append a single audit row whether the test succeeds or fails so
  // admins can correlate "what got tried, what it cost" with the
  // matching `llm_gateway_logs` row (joined on task_name+created_at).
  try {
    const response = await chatComplete(req)
    await appendTaskEngineAudit(
      taskName,
      'test',
      null,
      JSON.stringify({
        ok: true,
        costUsd: response.costUsd,
        latencyMs: response.latencyMs,
        cached: response.cached,
        model: response.model,
        providerId: response.providerId,
      }),
      'test',
      user.id,
    )
    return c.json({
      ok: true,
      result: response.content,
      costUsd: response.costUsd,
      latencyMs: response.latencyMs,
      cached: response.cached,
      model: response.model,
      providerId: response.providerId,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      tokensEstimated: response.tokensEstimated ?? false,
    })
  } catch (err) {
    const e = err as Error
    await appendTaskEngineAudit(
      taskName,
      'test',
      null,
      JSON.stringify({ ok: false, error: e.message }),
      'test',
      user.id,
    )
    if (err instanceof CostCapExceededError) {
      return c.json({ ok: false, error: e.message, code: 'cost_cap_exceeded', detail: err.spentUsd }, 402)
    }
    if (err instanceof NoProviderConfiguredError) {
      return c.json({ ok: false, error: e.message, code: 'no_provider_configured' }, 503)
    }
    if (err instanceof ProviderRateLimitError) {
      if (err.retryAfterSec) c.header('Retry-After', String(err.retryAfterSec))
      return c.json({ ok: false, error: e.message, code: 'rate_limited', detail: err.retryAfterSec }, 429)
    }
    if (err instanceof ProviderTimeoutError) {
      return c.json({ ok: false, error: e.message, code: 'timeout', detail: err.timeoutMs }, 504)
    }
    if (err instanceof ProviderAuthError) {
      return c.json({ ok: false, error: e.message, code: 'provider_auth' }, 502)
    }
    if (err instanceof ProviderError) {
      return c.json({ ok: false, error: e.message, code: 'provider_error', detail: err.statusCode }, 502)
    }
    return c.json({ ok: false, error: e.message ?? 'Unknown error', code: 'internal' }, 500)
  }
})

/** Test-only: clear the rate limit between cases. */
export function _resetTaskEngineTestRateLimitForTests(): void {
  testCounters.clear()
}

// Mount admin sub-router FIRST so `/audit` resolves before the
// catch-all `/:taskName` in `taskEnginesRead`. Read sub-router goes
// next so `:taskName` lookups don't fall into the admin-only PATCH
// guard. Both share the same prefix — Hono dispatches by path+method.
systemRouter.route('/task-engines', taskEnginesAdmin)
systemRouter.route('/task-engines', taskEnginesRead)
systemRouter.route('/task-engines', taskEnginesWrite)
