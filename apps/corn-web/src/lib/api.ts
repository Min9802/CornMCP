const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`)
  }
  return res.json()
}

// ─── Health ─────────────────────────────────────────────
export interface HealthData {
  status: string
  service: string
  version: string
  timestamp: string
  uptime: number
  services: Record<string, string>
}

export const checkHealth = () => apiFetch<HealthData>('/health')

// ─── Dashboard Overview ─────────────────────────────────
export interface DashboardOverview {
  projects: any[]
  totalAgents: number
  today: { queries: number; sessions: number }
  quality: { lastGrade: string; averageScore: number; reportsToday: number }
  knowledge: { totalDocs: number; totalChunks: number; totalHits: number }
  activeKeys: number
  totalSessions: number
  organizations: number
  uptime: number
  tokenSavings?: {
    totalTokensSaved: number
    totalToolCalls: number
    avgTokensPerCall: number
    topTools: { tool: string; tokensSaved: number }[]
  }
  tokenUsage?: {
    totalComputeTokens: number
    totalToolCalls: number
    avgTokensPerCall: number
  }
}

export const getDashboardOverview = () => apiFetch<DashboardOverview>('/api/metrics/overview')

// ─── Activity ───────────────────────────────────────────
export interface ActivityEvent {
  type: string
  detail: string
  agent_id: string
  status: string
  latency_ms?: number
  created_at: string
}

export const getActivityFeed = (limit = 20) =>
  apiFetch<{ activity: ActivityEvent[] }>(`/api/metrics/activity?limit=${limit}`)

// ─── Sessions ───────────────────────────────────────────
export const getSessions = (limit = 50) =>
  apiFetch<{ sessions: any[] }>(`/api/sessions?limit=${limit}`)

// ─── Quality ────────────────────────────────────────────
export const getQualityReports = (limit = 50) =>
  apiFetch<{ reports: any[] }>(`/api/quality?limit=${limit}`)

export const getQualityTrends = () =>
  apiFetch<{ trends: any[] }>('/api/quality/trends')

// ─── Projects ───────────────────────────────────────────
export const getProjects = () => apiFetch<{ projects: any[] }>('/api/projects')

export const createProject = (data: { name: string; description?: string; gitRepoUrl?: string }) =>
  apiFetch<{ ok: boolean; id: string }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(data),
  })

export const updateProject = (id: string, data: { name: string; description?: string; gitRepoUrl?: string }) =>
  apiFetch<{ ok: boolean }>(`/api/projects/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })

export const deleteProject = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' })

// ─── Knowledge ──────────────────────────────────────────
export const getKnowledgeDocs = (limit = 50) =>
  apiFetch<{ documents: any[] }>(`/api/knowledge?limit=${limit}`)

// ─── Memory ─────────────────────────────────────────────
export const getMemories = (params?: { limit?: number; projectId?: string; branch?: string; agentId?: string }) => {
  const qs = new URLSearchParams()
  qs.set('limit', String(params?.limit ?? 50))
  if (params?.projectId) qs.set('projectId', params.projectId)
  if (params?.branch) qs.set('branch', params.branch)
  if (params?.agentId) qs.set('agentId', params.agentId)
  return apiFetch<{ memories: any[] }>(`/api/memories?${qs.toString()}`)
}

export const deleteMemory = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/memories/${id}`, { method: 'DELETE' })

// ─── Keys ───────────────────────────────────────────────
export const getApiKeys = () => apiFetch<{ keys: any[] }>('/api/keys')

export const createApiKey = (data: { name: string; scope?: string }) =>
  apiFetch<{ id: string; key: string; name: string; message: string }>('/api/keys', {
    method: 'POST',
    body: JSON.stringify(data),
  })

export const deleteApiKey = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/keys/${id}`, { method: 'DELETE' })

// ─── Organizations ──────────────────────────────────────
export const getOrganizations = () =>
  apiFetch<{ organizations: any[] }>('/api/orgs')

/**
 * Create an organization. Admin callers may pass `userId` to assign the
 * org to another user; omitting it (or passing empty string) keeps the
 * current admin as the owner. Non-admin callers always own their orgs.
 */
export const createOrganization = (data: {
  name: string
  description?: string
  userId?: string
}) =>
  apiFetch<{ ok: boolean; id: string; userId?: string }>('/api/orgs', {
    method: 'POST',
    body: JSON.stringify(data),
  })

/**
 * Update an organization. Admin callers may pass `userId` to reassign
 * ownership (empty string = reassign to current admin). Field is ignored
 * when omitted, preserving the existing owner.
 */
export const updateOrganization = (
  id: string,
  data: { name: string; description?: string; userId?: string },
) =>
  apiFetch<{ ok: boolean }>(`/api/orgs/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })

export const deleteOrganization = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/orgs/${id}`, { method: 'DELETE' })

// ─── Providers ──────────────────────────────────────────
export const getProviders = () => apiFetch<{ providers: any[] }>('/api/providers')

// Embedding-capable providers — drives the System Settings embedding picker.
// Admin-only; returns all enabled providers tagged with capability=embedding.
export const getEmbeddingCandidates = () =>
  apiFetch<{ providers: any[] }>('/api/providers/embedding-candidates')

export const createProvider = (data: {
  name: string
  type: string
  apiBase: string
  apiKey?: string
  models?: string[]
  capabilities?: string[]
  dims?: number | null
}) =>
  apiFetch<{ ok: boolean; id: string }>('/api/providers', {
    method: 'POST',
    body: JSON.stringify(data),
  })

export const deleteProvider = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/providers/${id}`, { method: 'DELETE' })

export const updateProvider = (id: string, data: {
  name?: string
  apiBase?: string
  apiKey?: string
  models?: string[]
  status?: string
  capabilities?: string[]
  dims?: number | null
}) =>
  apiFetch<{ ok: boolean }>(`/api/providers/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })

// ─── Usage ──────────────────────────────────────────────
export const getUsageStats = (days = 30) =>
  apiFetch<{
    totalTokens: number
    totalRequests: number
    byModel: any[]
    byAgent: any[]
    daily: any[]
  }>(`/api/usage?days=${days}`)

// ─── Tool Analytics ─────────────────────────────────────
export interface ToolAnalytics {
  summary: {
    totalCalls: number
    overallSuccessRate: number
    estimatedTokensSaved: number
    totalDataBytes: number
    activeAgents: number
  }
  tools: {
    tool: string
    totalCalls: number
    successRate: number
    errorCount: number
    avgLatencyMs: number
  }[]
  agents: {
    agentId: string
    totalCalls: number
    successRate: number
  }[]
  trend: {
    day: string
    calls: number
    errors: number
  }[]
}

export const getToolAnalytics = (days = 30, opts?: { all?: boolean }) => {
  const qs = new URLSearchParams({ days: String(days) })
  if (opts?.all) qs.set('all', '1')
  return apiFetch<ToolAnalytics>(`/api/analytics/tool-analytics?${qs.toString()}`)
}

// ─── Users (admin only) ──────────────────────────────────
export interface UserRecord {
  id: string
  email: string
  name: string
  role: 'admin' | 'user'
  is_active: number
  created_at: string
}

export const getUsers = () => apiFetch<{ users: UserRecord[] }>('/api/users')

export const createUser = (data: { email: string; password: string; name: string; role?: string }) =>
  apiFetch<{ ok: boolean; id: string }>('/api/users', {
    method: 'POST',
    body: JSON.stringify(data),
  })

export const updateUser = (id: string, data: { name?: string; role?: string; isActive?: boolean; password?: string }) =>
  apiFetch<{ ok: boolean }>(`/api/users/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })

export const deleteUser = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/users/${id}`, { method: 'DELETE' })

// ─── System Settings (admin only) — S3 ───────────────────
export interface SystemSetting {
  key: string
  is_secret: 0 | 1
  category: string
  description: string | null
  default_value: string | null
  updated_by: string | null
  updated_at: string
  value_set: boolean
  /** '' if not set; raw value if !is_secret; ••••<last4> if is_secret */
  value_masked: string
}

export interface SystemSettingDefault {
  key: string
  category: string
  description: string
  isSecret: boolean
  envVar?: string
  defaultValue?: string
}

export interface SystemSettingAudit {
  id: number
  key: string
  old_value: string | null
  new_value: string | null
  action: string
  changed_by: string | null
  changed_at: string
}

export interface SystemSettingReveal {
  key: string
  value: string | null
  is_secret: boolean
  source: 'db' | 'env' | 'none'
  rate_limit: { remaining: number }
}

export interface MigrateFromEnvResult {
  migrated: string[]
  skipped: { key: string; reason: 'already_set' | 'no_env' | 'env_empty' }[]
}

export const getSystemSettings = (category?: string) => {
  const qs = category ? `?category=${encodeURIComponent(category)}` : ''
  return apiFetch<{ settings: SystemSetting[] }>(`/api/system/settings${qs}`)
}

export const getSystemSettingDefaults = () =>
  apiFetch<{ defaults: SystemSettingDefault[] }>('/api/system/settings/defaults')

export const updateSystemSetting = (
  key: string,
  body: { value: string | null; isSecret?: boolean; category?: string; description?: string; defaultValue?: string },
) =>
  apiFetch<{ ok: boolean }>(`/api/system/settings/${encodeURIComponent(key)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })

export const revealSystemSetting = (key: string) =>
  apiFetch<SystemSettingReveal>(`/api/system/settings/${encodeURIComponent(key)}/reveal`)

export const getSystemSettingAudit = (key: string, limit = 50) =>
  apiFetch<{ entries: SystemSettingAudit[] }>(
    `/api/system/settings/audit/${encodeURIComponent(key)}?limit=${limit}`,
  )

export const migrateSystemSettingsFromEnv = () =>
  apiFetch<MigrateFromEnvResult>('/api/system/settings/migrate-from-env', { method: 'POST' })

// ─── Task Engines (admin only) — S6 ──────────────────────
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

export interface TaskEngineDefault {
  taskName: string
  description: string
  suggestedModel?: string
  promptTemplate?: string
  maxOutputTokens?: number
}

export interface TaskEngineUpdatePatch {
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
}

export interface TaskEngineAuditEntry {
  id: number
  task_name: string
  field: string
  old_value: string | null
  new_value: string | null
  action: 'update' | 'test' | 'reset'
  changed_by: string | null
  changed_at: string
}

export interface TaskEngineTestResult {
  ok: true
  result: string
  costUsd: number
  latencyMs: number
  cached: boolean
  model: string
  providerId: string
  inputTokens: number
  outputTokens: number
  tokensEstimated: boolean
}

export interface TaskEngineTestError {
  ok: false
  error: string
  code?: string
  detail?: string | number
}

export const getTaskEngines = () =>
  apiFetch<{ configs: TaskEngineConfig[] }>('/api/system/task-engines')

export const getTaskEngineDefaults = () =>
  apiFetch<{ defaults: TaskEngineDefault[] }>('/api/system/task-engines/defaults')

export const getTaskEngine = (taskName: string) =>
  apiFetch<{ config: TaskEngineConfig }>(`/api/system/task-engines/${encodeURIComponent(taskName)}`)

export const updateTaskEngine = (taskName: string, patch: TaskEngineUpdatePatch) =>
  apiFetch<{ config: TaskEngineConfig }>(`/api/system/task-engines/${encodeURIComponent(taskName)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })

export const testTaskEngine = (taskName: string, input: string) =>
  apiFetch<TaskEngineTestResult | TaskEngineTestError>(
    `/api/system/task-engines/${encodeURIComponent(taskName)}/test`,
    {
      method: 'POST',
      body: JSON.stringify({ input }),
    },
  )

export const getTaskEngineAudit = (taskName?: string, limit = 50) => {
  const qs = new URLSearchParams()
  if (taskName) qs.set('taskName', taskName)
  qs.set('limit', String(limit))
  return apiFetch<{ entries: TaskEngineAuditEntry[] }>(
    `/api/system/task-engines/audit?${qs.toString()}`,
  )
}

// ─── LLM Stats (admin only) — S6.4 ───────────────────────
export interface LlmStatsTotals {
  totalCalls: number
  successfulCalls: number
  cachedCalls: number
  erroredCalls: number
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  avgLatencyMs: number
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
  recentErrors: { taskName: string | null; provider: string | null; model: string | null; error: string; createdAt: string }[]
}

export interface CostCapStatus {
  spentUsd: number
  capUsd: number
  pctUsed: number | null
  warning: boolean
  exceeded: boolean
}

export const getLlmStats = (days = 1) =>
  apiFetch<LlmStats>(`/api/llm/stats?days=${days}`)

export const getCostCapStatus = () =>
  apiFetch<CostCapStatus>('/api/llm/cost-cap-status')
