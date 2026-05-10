'use client'

// Tab "Task Engines" inside /admin/system-settings (S6.3 / S6.4).
//
// One file holds the full subtree (CostWidget + row list + Configure
// modal + Test panel + Audit modal) on purpose: the components are
// tightly coupled — the modal mutates the row, the test panel writes
// audit rows the modal reads back, the cost widget reflects the test
// outcome. Splitting them across files would force prop-drilling or
// pulling in a state library; the current single-file shape keeps the
// data flow obvious.
//
// All API calls go through `lib/api.ts` (typed). All interactive parts
// gate on `isAdmin` at the page level — the parent already returns a
// 403-style card to non-admins, so this file assumes admin context.

import { useEffect, useMemo, useState } from 'react'
import useSWR, { mutate as globalMutate } from 'swr'
import {
  getTaskEngines,
  getTaskEngineDefaults,
  updateTaskEngine,
  testTaskEngine,
  getTaskEngineAudit,
  getLlmStats,
  getCostCapStatus,
  getProviders,
  type TaskEngineConfig,
  type TaskEngineDefault,
  type TaskEngineUpdatePatch,
  type TaskEngineAuditEntry,
  type TaskEngineTestResult,
  type TaskEngineTestError,
  type LlmStats,
  type CostCapStatus,
} from '@/lib/api'
import { formatLocalDate } from '@/lib/date'

// Hardcoded fallback model list when admin hasn't configured a provider
// yet — mirrors `DEFAULT_PRICING` keys in `apps/corn-api/src/services/llm-gateway/cost.ts`.
// Keep these in sync; treat as a UI hint, not a contract.
const COMMON_MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'o1-mini',
  'o3-mini',
  'claude-3-5-haiku-20241022',
  'claude-3-5-sonnet-20241022',
  'claude-3-7-sonnet-20250219',
  'claude-sonnet-4-5-20250929',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-2.0-flash',
] as const

interface ProviderRow {
  id: string
  name: string
  type: string
  status: string
  models?: string | string[]
}

function parseModels(p: ProviderRow): string[] {
  if (!p.models) return []
  if (Array.isArray(p.models)) return p.models
  try {
    const parsed = JSON.parse(p.models)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function fmtUsd(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(6)}`
  if (n < 1) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return `${(n * 100).toFixed(1)}%`
}

// ─── Main TasksTab ──────────────────────────────────────
export default function TasksTab() {
  const { data: enginesData, isLoading: enginesLoading, mutate: mutateEngines } = useSWR(
    'task-engines',
    getTaskEngines,
  )
  const { data: defaultsData } = useSWR('task-engine-defaults', getTaskEngineDefaults)
  const { data: providersData } = useSWR('providers-for-tasks', getProviders)

  const configs = enginesData?.configs ?? []
  const defaults = defaultsData?.defaults ?? []
  const providers: ProviderRow[] = (providersData?.providers as ProviderRow[]) ?? []
  const enabledProviders = providers.filter((p) => p.status !== 'disabled')

  const [editing, setEditing] = useState<TaskEngineConfig | null>(null)
  const [auditOpen, setAuditOpen] = useState<{ taskName?: string } | null>(null)

  if (enginesLoading) {
    return <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>Loading task engines…</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <CostWidget />

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-3)', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          <h3 style={{ fontWeight: 700 }}>
            Task engines <span style={{ color: 'var(--text-muted)', fontWeight: 500, fontSize: '0.85rem' }}>({configs.length})</span>
          </h3>
          <button className="btn btn-secondary btn-sm" onClick={() => setAuditOpen({})}>
            📜 View all audit
          </button>
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 'var(--space-4)' }}>
          Toggle each MCP task between local heuristic (free, deterministic) and LLM (configured provider/model). Enabling LLM
          on a row routes through the gateway with the per-task budget and prompt template you set here. Hot-reload ≤ 60s on
          both sides (corn-api cache + corn-mcp dispatcher cache).
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {configs.map((config) => {
            const spec = defaults.find((d) => d.taskName === config.task_name)
            return (
              <TaskEngineRow
                key={config.task_name}
                config={config}
                spec={spec}
                onEdit={() => setEditing(config)}
                onAudit={() => setAuditOpen({ taskName: config.task_name })}
              />
            )
          })}
        </div>
      </div>

      {editing && (
        <TaskEngineModal
          config={editing}
          spec={defaults.find((d) => d.taskName === editing.task_name)}
          providers={enabledProviders}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setEditing(null)
            void mutateEngines()
            // Bust per-task audit cache so the History modal repopulates.
            void globalMutate(`task-engine-audit:${updated.task_name}`, undefined, { revalidate: false })
            void globalMutate('task-engine-audit:all', undefined, { revalidate: false })
          }}
        />
      )}
      {auditOpen && (
        <AuditModal
          taskName={auditOpen.taskName}
          onClose={() => setAuditOpen(null)}
        />
      )}
    </div>
  )
}

// ─── Cost dashboard widget (S6.4) ───────────────────────
function CostWidget() {
  const { data: today } = useSWR('llm-stats-today', () => getLlmStats(1), { refreshInterval: 60_000 })
  const { data: week } = useSWR('llm-stats-week', () => getLlmStats(7))
  const { data: month } = useSWR('llm-stats-month', () => getLlmStats(30))
  const { data: cap } = useSWR('llm-cost-cap-status', getCostCapStatus, { refreshInterval: 60_000 })

  const capPct = cap?.pctUsed ?? null
  const capTone =
    cap?.exceeded ? 'var(--corn-red)' :
    cap?.warning ? 'var(--corn-orange, #f97316)' :
    'var(--corn-green)'

  return (
    <div className="card" style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-4)', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
        <h3 style={{ fontWeight: 700 }}>💰 LLM cost</h3>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          auto-refresh 60s
        </span>
      </div>

      {/* Spent vs cap bar */}
      {cap && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Today: <strong style={{ color: capTone }}>{fmtUsd(cap.spentUsd)}</strong>
              {cap.capUsd > 0 && (
                <span style={{ color: 'var(--text-muted)' }}> / cap {fmtUsd(cap.capUsd)} ({fmtPct(capPct)})</span>
              )}
              {cap.capUsd === 0 && <span style={{ color: 'var(--text-muted)' }}> · cap disabled</span>}
            </span>
            {cap.exceeded && <span className="badge badge-warning">cap reached — calls blocked</span>}
            {!cap.exceeded && cap.warning && <span className="badge badge-warning">≥80% cap</span>}
          </div>
          {cap.capUsd > 0 && (
            <div style={{ height: 8, background: 'var(--bg-input)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${Math.min(100, (capPct ?? 0) * 100)}%`,
                  height: '100%',
                  background: capTone,
                  transition: 'width 0.3s',
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* 4 cards: today / week / month / cache */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 'var(--space-3)' }}>
        <CostCell label="Today" stats={today} />
        <CostCell label="7 days" stats={week} />
        <CostCell label="30 days" stats={month} />
        <div style={{ padding: 'var(--space-3)', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)', textAlign: 'center' }}>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Cache hit (today)</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--corn-gold)', marginTop: 4 }}>
            {today ? fmtPct(today.totals.cacheHitRate) : '—'}
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
            {today ? `${today.totals.cachedCalls}/${today.totals.totalCalls} calls` : '—'}
          </div>
        </div>
      </div>

      {/* Top 5 by cost */}
      {today && today.byTask.length > 0 && (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 'var(--space-2)' }}>
            Top tasks (today)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {today.byTask.slice(0, 5).map((b) => (
              <div key={b.key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', padding: '4px 0' }}>
                <code style={{ color: 'var(--corn-gold)' }}>{b.key}</code>
                <span style={{ color: 'var(--text-secondary)' }}>
                  {b.calls} calls · <strong>{fmtUsd(b.costUsd)}</strong> · {b.avgLatencyMs}ms avg
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent errors */}
      {today && today.recentErrors.length > 0 && (
        <details style={{ marginTop: 'var(--space-4)' }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.85rem', color: 'var(--corn-red)' }}>
            ⚠ {today.recentErrors.length} recent error(s) (today)
          </summary>
          <div style={{ marginTop: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.8rem', fontFamily: 'monospace' }}>
            {today.recentErrors.map((e, i) => (
              <div key={i} style={{ padding: '4px 8px', background: 'rgba(239,68,68,0.06)', borderLeft: '2px solid var(--corn-red)', borderRadius: 4 }}>
                <span style={{ color: 'var(--text-muted)' }}>{formatLocalDate(e.createdAt)}</span>{' '}
                <code style={{ color: 'var(--corn-gold)' }}>{e.taskName ?? '—'}</code>{' '}
                <span style={{ color: 'var(--text-secondary)' }}>{e.provider ?? '?'}/{e.model ?? '?'}</span>:{' '}
                <span>{e.error}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

function CostCell({ label, stats }: { label: string; stats: LlmStats | undefined }) {
  return (
    <div style={{ padding: 'var(--space-3)', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)', textAlign: 'center' }}>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: '1.4rem', fontWeight: 700, marginTop: 4 }}>
        {stats ? fmtUsd(stats.totals.totalCostUsd) : '—'}
      </div>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
        {stats ? `${stats.totals.totalCalls} calls · ${stats.totals.avgLatencyMs}ms avg` : '—'}
      </div>
    </div>
  )
}

// ─── Single task row (S6.1) ─────────────────────────────
function TaskEngineRow({
  config,
  spec,
  onEdit,
  onAudit,
}: {
  config: TaskEngineConfig
  spec: TaskEngineDefault | undefined
  onEdit: () => void
  onAudit: () => void
}) {
  const isLlm = config.engine === 'llm'
  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--space-3)',
        padding: 'var(--space-3) var(--space-4)',
        background: 'var(--bg-input)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border)',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
      }}
    >
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <code style={{ color: 'var(--corn-gold)', fontSize: '0.95rem' }}>{config.task_name}</code>
          <span className={`badge ${isLlm ? 'badge-healthy' : 'badge-info'}`}>
            {isLlm ? '🤖 LLM' : '⚙️ Heuristic'}
          </span>
          {config.enabled === 0 && <span className="badge badge-warning">disabled</span>}
          {isLlm && config.fallback_to_heuristic === 0 && (
            <span className="badge badge-warning">no fallback</span>
          )}
        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>
          {config.description ?? spec?.description ?? '(no description)'}
        </div>
        {isLlm && (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, fontFamily: 'monospace' }}>
            {config.provider_id ? `provider: ${config.provider_id}` : 'provider: (env fallback)'} · model: {config.model ?? '(none)'} · cap: {fmtUsd(config.cost_cap_usd_per_day)}/day
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-primary btn-sm" onClick={onEdit}>
          Configure
        </button>
        <button className="btn btn-secondary btn-sm" onClick={onAudit}>
          History
        </button>
      </div>
    </div>
  )
}

// ─── Configure modal (S6.2) ─────────────────────────────
function TaskEngineModal({
  config,
  spec,
  providers,
  onClose,
  onSaved,
}: {
  config: TaskEngineConfig
  spec: TaskEngineDefault | undefined
  providers: ProviderRow[]
  onClose: () => void
  onSaved: (updated: TaskEngineConfig) => void
}) {
  const [engine, setEngine] = useState(config.engine)
  const [enabled, setEnabled] = useState(config.enabled === 1)
  const [fallback, setFallback] = useState(config.fallback_to_heuristic === 1)
  const [providerId, setProviderId] = useState<string>(config.provider_id ?? '')
  const [model, setModel] = useState<string>(config.model ?? spec?.suggestedModel ?? '')
  const [promptTemplate, setPromptTemplate] = useState<string>(config.prompt_template ?? '')
  const [timeoutMs, setTimeoutMs] = useState<number>(config.timeout_ms)
  const [maxOut, setMaxOut] = useState<number>(config.max_output_tokens)
  const [maxIn, setMaxIn] = useState<number>(config.max_input_tokens)
  const [temperature, setTemperature] = useState<number>(config.temperature)
  const [cacheTtl, setCacheTtl] = useState<number>(config.cache_ttl_sec)
  const [costCap, setCostCap] = useState<number>(config.cost_cap_usd_per_day)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Test panel state — separate from save flow.
  const [testInput, setTestInput] = useState<string>('Test plan: refactor login flow.')
  const [testRunning, setTestRunning] = useState(false)
  const [testResult, setTestResult] = useState<TaskEngineTestResult | TaskEngineTestError | null>(null)

  // Helpful list of models. If a provider is selected, prefer its
  // declared models; otherwise show the canonical fallback list.
  const modelOptions = useMemo<string[]>(() => {
    if (providerId) {
      const p = providers.find((x) => x.id === providerId)
      const list = p ? parseModels(p) : []
      if (list.length > 0) return list
    }
    return [...COMMON_MODELS]
  }, [providerId, providers])

  // Reset to default values from `spec` (or the hardcoded defaults from
  // updateTaskEngineConfig). Stays in local state until Save.
  const handleResetLocal = () => {
    setEngine('heuristic')
    setEnabled(true)
    setFallback(true)
    setProviderId('')
    setModel(spec?.suggestedModel ?? '')
    setPromptTemplate(spec?.promptTemplate ?? '')
    setTimeoutMs(30_000)
    setMaxIn(8000)
    setMaxOut(spec?.maxOutputTokens ?? 1024)
    setTemperature(0.2)
    setCacheTtl(3600)
    setCostCap(0)
  }

  const validation = useMemo(() => {
    if (timeoutMs <= 0) return 'timeoutMs must be > 0'
    if (maxIn <= 0) return 'maxInputTokens must be > 0'
    if (maxOut <= 0) return 'maxOutputTokens must be > 0'
    if (temperature < 0 || temperature > 2) return 'temperature must be in [0, 2]'
    if (cacheTtl < 0) return 'cacheTtlSec must be ≥ 0'
    if (costCap < 0) return 'costCapUsdPerDay must be ≥ 0'
    if (engine === 'llm' && !model.trim()) return 'model is required when engine=llm'
    return null
  }, [timeoutMs, maxIn, maxOut, temperature, cacheTtl, costCap, engine, model])

  const handleSave = async () => {
    if (validation) return
    setSaving(true)
    setSaveMsg(null)
    try {
      const patch: TaskEngineUpdatePatch = {
        engine,
        enabled,
        fallbackToHeuristic: fallback,
        providerId: providerId || null,
        model: model.trim() || null,
        promptTemplate: promptTemplate.trim() || null,
        timeoutMs,
        maxInputTokens: maxIn,
        maxOutputTokens: maxOut,
        temperature,
        cacheTtlSec: cacheTtl,
        costCapUsdPerDay: costCap,
      }
      const r = await updateTaskEngine(config.task_name, patch)
      setSaveMsg('Saved ✓ (hot-reload ≤60s in dispatcher)')
      onSaved(r.config)
    } catch (e: any) {
      setSaveMsg(e.message?.replace(/^API \d+: /, '') || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    if (engine !== 'llm') {
      setTestResult({ ok: false, error: 'Test only available when engine="llm". Save engine=llm first.' })
      return
    }
    setTestRunning(true)
    setTestResult(null)
    try {
      const r = await testTaskEngine(config.task_name, testInput)
      setTestResult(r)
    } catch (e: any) {
      const msg = e.message?.replace(/^API \d+: /, '') || 'Test failed'
      setTestResult({ ok: false, error: msg })
    } finally {
      setTestRunning(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 'var(--space-4)', overflow: 'auto',
      }}
      onClick={onClose}
    >
      <div
        className="card animate-in"
        style={{ width: '100%', maxWidth: 760, marginTop: 'var(--space-6)', marginBottom: 'var(--space-6)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 'var(--space-4)', gap: 'var(--space-3)' }}>
          <div>
            <h3 style={{ fontWeight: 700, marginBottom: 4 }}>
              Configure task <code style={{ color: 'var(--corn-gold)' }}>{config.task_name}</code>
            </h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              {spec?.description ?? config.description ?? '(no description)'}
            </p>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {/* Engine + flags */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'center' }}>
            <label style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center' }}>
              <input
                type="radio"
                checked={engine === 'heuristic'}
                onChange={() => setEngine('heuristic')}
              /> Heuristic
            </label>
            <label style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center' }}>
              <input
                type="radio"
                checked={engine === 'llm'}
                onChange={() => setEngine('llm')}
              /> LLM
            </label>
            <label style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center', marginLeft: 'var(--space-3)' }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Enabled
            </label>
            {engine === 'llm' && (
              <label style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center' }}>
                <input type="checkbox" checked={fallback} onChange={(e) => setFallback(e.target.checked)} />
                Fall back to heuristic on LLM error
              </label>
            )}
          </div>

          {/* Provider + model (only relevant for llm) */}
          {engine === 'llm' && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-3)' }}>
                <div>
                  <label style={fieldLabelStyle}>Provider</label>
                  <select
                    className="input"
                    value={providerId}
                    onChange={(e) => setProviderId(e.target.value)}
                    style={{ width: '100%' }}
                  >
                    <option value="">(env fallback)</option>
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {p.type}
                      </option>
                    ))}
                  </select>
                  <p style={fieldHintStyle}>
                    Empty = let the gateway pick the first env-backed provider (S4.10).
                  </p>
                </div>
                <div>
                  <label style={fieldLabelStyle}>Model</label>
                  <input
                    list={`models-${config.task_name}`}
                    className="input"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={spec?.suggestedModel ?? 'e.g. gpt-4o-mini'}
                    style={{ width: '100%' }}
                  />
                  <datalist id={`models-${config.task_name}`}>
                    {modelOptions.map((m) => <option key={m} value={m} />)}
                  </datalist>
                </div>
              </div>

              <div>
                <label style={fieldLabelStyle}>Prompt template</label>
                <textarea
                  className="input"
                  value={promptTemplate}
                  onChange={(e) => setPromptTemplate(e.target.value)}
                  placeholder="System prompt. Use {{input}} to inject the runtime input. Leave blank for the gateway default."
                  rows={4}
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.85rem' }}
                />
                <p style={fieldHintStyle}>
                  <code>{'{{input}}'}</code> is substituted at call time. If the template has no token, it acts as the system prompt and the runtime input becomes the user message.
                </p>
              </div>
            </>
          )}

          {/* Numeric knobs grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 'var(--space-3)' }}>
            <NumberField label="Timeout ms" value={timeoutMs} onChange={setTimeoutMs} step={500} min={500} />
            <NumberField label="Max input tokens" value={maxIn} onChange={setMaxIn} step={100} min={1} />
            <NumberField label="Max output tokens" value={maxOut} onChange={setMaxOut} step={50} min={1} />
            <NumberField label="Temperature" value={temperature} onChange={setTemperature} step={0.1} min={0} max={2} />
            <NumberField label="Cache TTL sec" value={cacheTtl} onChange={setCacheTtl} step={60} min={0} />
            <NumberField label="Cost cap $/day" value={costCap} onChange={setCostCap} step={0.5} min={0} hint="0 = unlimited (uses global cap)" />
          </div>

          {validation && (
            <div style={{ fontSize: '0.85rem', color: 'var(--corn-red)' }}>⚠ {validation}</div>
          )}

          {/* Save row */}
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-3)' }}>
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving || !!validation}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={handleResetLocal} title="Reset modal fields to plan defaults (does not save)">
              Reset to default
            </button>
            {saveMsg && (
              <span
                style={{
                  fontSize: '0.85rem',
                  color: saveMsg.includes('✓') ? 'var(--corn-green)' : 'var(--corn-red)',
                  alignSelf: 'center',
                }}
              >
                {saveMsg}
              </span>
            )}
          </div>

          {/* Test panel — visible for llm engine; hidden otherwise */}
          {engine === 'llm' && (
            <div style={{ marginTop: 'var(--space-3)', padding: 'var(--space-3)', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600, marginBottom: 'var(--space-2)' }}>🧪 Test prompt (live LLM call · audit + cost logged)</div>
              <textarea
                className="input"
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                rows={3}
                style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.85rem' }}
                placeholder="Sample input — substituted into {{input}} or sent as user message."
              />
              <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" onClick={handleTest} disabled={testRunning}>
                  {testRunning ? 'Running…' : 'Run test'}
                </button>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Save first if you changed config — Test reads the persisted row.
                </span>
              </div>
              {testResult && <TestResultPanel result={testResult} />}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function TestResultPanel({ result }: { result: TaskEngineTestResult | TaskEngineTestError }) {
  if (!result.ok) {
    return (
      <div style={{ marginTop: 'var(--space-2)', padding: 'var(--space-2) var(--space-3)', background: 'rgba(239,68,68,0.08)', borderLeft: '3px solid var(--corn-red)', borderRadius: 4, fontSize: '0.85rem' }}>
        <div style={{ fontWeight: 600, color: 'var(--corn-red)', marginBottom: 4 }}>❌ Test failed{result.code ? ` (${result.code})` : ''}</div>
        <div style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>{result.error}</div>
      </div>
    )
  }
  return (
    <div style={{ marginTop: 'var(--space-2)', padding: 'var(--space-2) var(--space-3)', background: 'rgba(16,185,129,0.06)', borderLeft: '3px solid var(--corn-green)', borderRadius: 4, fontSize: '0.85rem' }}>
      <div style={{ fontWeight: 600, color: 'var(--corn-green)', marginBottom: 4 }}>
        ✅ {result.cached ? 'Cached' : 'Live'} · {fmtUsd(result.costUsd)} · {result.latencyMs}ms · {result.inputTokens}+{result.outputTokens} tokens
        {result.tokensEstimated && <span style={{ color: 'var(--text-muted)' }}> (estimated)</span>}
      </div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 6 }}>
        {result.providerId} · {result.model}
      </div>
      <pre style={{ margin: 0, padding: 'var(--space-2)', background: 'var(--bg-secondary)', borderRadius: 4, maxHeight: 200, overflow: 'auto', fontSize: '0.8rem', whiteSpace: 'pre-wrap' }}>
        {result.result}
      </pre>
    </div>
  )
}

// ─── Audit modal (S6.3 / generic) ───────────────────────
function AuditModal({ taskName, onClose }: { taskName?: string; onClose: () => void }) {
  const cacheKey = taskName ? `task-engine-audit:${taskName}` : 'task-engine-audit:all'
  const { data, isLoading } = useSWR(cacheKey, () => getTaskEngineAudit(taskName, 100))
  const entries = data?.entries ?? []

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-4)',
      }}
      onClick={onClose}
    >
      <div className="card animate-in" style={{ width: '100%', maxWidth: 880, maxHeight: '85vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-4)' }}>
          <h3 style={{ fontWeight: 700 }}>
            Task engine audit · {taskName ? <code style={{ color: 'var(--corn-gold)' }}>{taskName}</code> : 'all tasks'}
          </h3>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
        </div>
        {isLoading ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 'var(--space-6)' }}>Loading…</div>
        ) : entries.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 'var(--space-6)' }}>No audit entries yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
                {(taskName
                  ? ['When', 'By', 'Action', 'Field', 'Old', 'New']
                  : ['When', 'By', 'Task', 'Action', 'Field', 'Old', 'New']
                ).map((h) => (
                  <th key={h} style={{ padding: 'var(--space-2) var(--space-3)', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', fontSize: '0.7rem', letterSpacing: '0.05em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((e: TaskEngineAuditEntry) => (
                <tr key={e.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={cellStyle}>{formatLocalDate(e.changed_at)}</td>
                  <td style={cellStyle}>{e.changed_by ?? '—'}</td>
                  {!taskName && (
                    <td style={cellStyle}><code style={{ color: 'var(--corn-gold)' }}>{e.task_name}</code></td>
                  )}
                  <td style={cellStyle}>
                    <span className={`badge ${
                      e.action === 'test' ? 'badge-info' :
                      e.action === 'reset' ? 'badge-warning' :
                      'badge-healthy'
                    }`}>
                      {e.action}
                    </span>
                  </td>
                  <td style={{ ...cellStyle, fontFamily: 'monospace' }}>{e.field}</td>
                  <td style={{ ...cellStyle, fontFamily: 'monospace', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.old_value ?? ''}>
                    {e.old_value ?? <em style={{ color: 'var(--text-muted)' }}>null</em>}
                  </td>
                  <td style={{ ...cellStyle, fontFamily: 'monospace', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.new_value ?? ''}>
                    {e.new_value ?? <em style={{ color: 'var(--text-muted)' }}>null</em>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ─── Shared UI helpers ──────────────────────────────────
function NumberField({
  label,
  value,
  onChange,
  step,
  min,
  max,
  hint,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
  max?: number
  hint?: string
}) {
  return (
    <div>
      <label style={fieldLabelStyle}>{label}</label>
      <input
        type="number"
        className="input"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => {
          const n = Number(e.target.value)
          onChange(Number.isFinite(n) ? n : 0)
        }}
        step={step ?? 1}
        min={min}
        max={max}
        style={{ width: '100%' }}
      />
      {hint && <p style={fieldHintStyle}>{hint}</p>}
    </div>
  )
}

const fieldLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.7rem',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 4,
  fontWeight: 600,
}

const fieldHintStyle: React.CSSProperties = {
  fontSize: '0.7rem',
  color: 'var(--text-muted)',
  marginTop: 4,
}

const cellStyle: React.CSSProperties = {
  padding: 'var(--space-2) var(--space-3)',
  color: 'var(--text-secondary)',
  whiteSpace: 'nowrap',
}

// Suppress an unused-var warning for the `useEffect` import — kept in
// case future contributors need it. Tree-shaken in prod build.
void useEffect
