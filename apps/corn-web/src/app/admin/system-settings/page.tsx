'use client'

// Admin System Settings page (S3.1 / S3.2 / S3.5 UI).
// Tabs: Environment (runtime config) · Audit Log · Task Engines (S6 stub).
// Non-admins are blocked at the render layer (DashboardLayout already bounces
// unauthenticated users; we additionally gate by role to avoid a flash of
// admin UI during the SWR revalidate race).

import { useMemo, useState, useEffect, useCallback, createContext, useContext } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import DashboardLayout from '@/components/layout/DashboardLayout'
import { getMe } from '@/lib/auth'
import {
  getSystemSettings,
  getSystemSettingDefaults,
  updateSystemSetting,
  revealSystemSetting,
  getSystemSettingAudit,
  migrateSystemSettingsFromEnv,
  getEmbeddingCandidates,
  type SystemSetting,
  type SystemSettingDefault,
  type SystemSettingAudit,
} from '@/lib/api'
import { formatLocalDate } from '@/lib/date'
import TasksTab from './tasks-tab'
import { useConfirm } from '@/components/ConfirmProvider'

// ── Merge type used by the Environment tab ───────────────
// A row is either backed by a DB entry, a default-only spec (key known but
// never saved), or both. `spec` drives the UI (description/envVar hint),
// `row` drives live values + mask.
interface EnvRow {
  key: string
  category: string
  description: string
  isSecret: boolean
  envVar?: string
  defaultValue?: string
  row?: SystemSetting
}

function sourceBadge(row?: SystemSetting) {
  if (!row) return { label: 'not set', cls: 'badge-info' }
  if (row.value_set) return { label: 'DB', cls: 'badge-healthy' }
  return { label: 'env / default', cls: 'badge-warning' }
}

// ─── Embedding preset context (Phase 1) ──────────────────
// Lets EmbeddingPresetSelector push values into multiple SettingRowEditors
// at once without lifting every field's local state up to the parent.
// Each editor watches `version` and adopts the matching `values[key]`
// when version increments — so re-applying the same preset re-fires the
// fill (e.g. user nudged a field then wants to revert).
interface PresetApplyState {
  values: Record<string, string>
  version: number
}
const PresetApplyContext = createContext<PresetApplyState>({ values: {}, version: 0 })

// Note: the hardcoded EMBEDDING_PRESETS dropdown was replaced by
// EmbeddingProviderPicker — see below. Admins now select a real
// configured Provider Account row instead of choosing from a fixed list,
// which removes the `host.docker.internal` confusion and keeps a single
// source of truth in `provider_accounts`.

type Tab = 'env' | 'audit' | 'tasks'

export default function SystemSettingsPage() {
  const { data: me, isLoading: meLoading } = useSWR('me', getMe, { revalidateOnFocus: false })
  const isAdmin = me?.role === 'admin'

  const [tab, setTab] = useState<Tab>('env')

  // Load settings + defaults regardless of tab so the Migrate banner has
  // accurate counts on mount.
  const { data: settingsData, mutate: mutateSettings, isLoading: settingsLoading } = useSWR(
    isAdmin ? 'sys-settings' : null,
    () => getSystemSettings(),
  )
  const { data: defaultsData, isLoading: defaultsLoading } = useSWR(
    isAdmin ? 'sys-settings-defaults' : null,
    getSystemSettingDefaults,
  )

  const rows = useMemo<EnvRow[]>(() => {
    const byKey = new Map<string, SystemSetting>()
    for (const s of settingsData?.settings ?? []) byKey.set(s.key, s)

    const out: EnvRow[] = []
    for (const spec of defaultsData?.defaults ?? []) {
      out.push({
        key: spec.key,
        category: spec.category,
        description: spec.description,
        isSecret: spec.isSecret,
        envVar: spec.envVar,
        defaultValue: spec.defaultValue,
        row: byKey.get(spec.key),
      })
    }
    // Surface any custom keys that aren't in the schema (e.g. admin-added)
    for (const s of settingsData?.settings ?? []) {
      if (!out.find((r) => r.key === s.key)) {
        out.push({
          key: s.key,
          category: s.category,
          description: s.description ?? '',
          isSecret: s.is_secret === 1,
          row: s,
        })
      }
    }
    return out
  }, [settingsData, defaultsData])

  const grouped = useMemo(() => {
    return rows.reduce<Record<string, EnvRow[]>>((acc, r) => {
      ;(acc[r.category] ??= []).push(r)
      return acc
    }, {})
  }, [rows])

  // Migrate banner visibility: show when at least one default key has a
  // matching env var but no DB row yet.
  const unseeded = rows.filter((r) => !r.row?.value_set && r.envVar).length

  if (meLoading) {
    return (
      <DashboardLayout title="System Settings" subtitle="Runtime configuration (admin only)">
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
      </DashboardLayout>
    )
  }

  if (!isAdmin) {
    return (
      <DashboardLayout title="System Settings" subtitle="Runtime configuration (admin only)">
        <div className="card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: 'var(--space-3)' }}>🔒</div>
          <h3 style={{ fontWeight: 700, marginBottom: 'var(--space-2)' }}>Admin role required</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Ask an administrator to upgrade your account to access this page.
          </p>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout title="System Settings" subtitle="Runtime configuration · admin only · hot-reload ≤60s">
      {/* Tabs */}
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-5)', borderBottom: '1px solid var(--border)' }}>
        {([
          { id: 'env', label: 'Environment', icon: '🌱' },
          { id: 'audit', label: 'Audit Log', icon: '📜' },
          { id: 'tasks', label: 'Task Engines', icon: '⚙️' },
        ] as { id: Tab; label: string; icon: string }[]).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={tab === t.id ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
            style={{
              borderBottomLeftRadius: 0,
              borderBottomRightRadius: 0,
              marginBottom: -1,
              borderBottom: tab === t.id ? '2px solid var(--corn-gold)' : '1px solid transparent',
            }}
          >
            <span>{t.icon}</span> <span>{t.label}</span>
          </button>
        ))}
      </div>

      {tab === 'env' && (
        <EnvironmentTab
          grouped={grouped}
          loading={settingsLoading || defaultsLoading}
          unseeded={unseeded}
          refresh={() => mutateSettings()}
        />
      )}
      {tab === 'audit' && <AuditTab rows={rows} />}
      {tab === 'tasks' && <TasksTab />}
    </DashboardLayout>
  )
}

// ─── Environment tab ────────────────────────────────────
// Dirty entry tracked at the parent so the Save-All panel can drive
// every row at once. We keep the per-row Save button for granular saves.
interface DirtyEntry {
  value: string
  row: EnvRow
  hasError: boolean
}

function EnvironmentTab({
  grouped,
  loading,
  unseeded,
  refresh,
}: {
  grouped: Record<string, EnvRow[]>
  loading: boolean
  unseeded: number
  refresh: () => void
}) {
  const { mutate } = useSWRConfig()
  const confirm = useConfirm()
  const [migrateRunning, setMigrateRunning] = useState(false)
  const [migrateMsg, setMigrateMsg] = useState<string | null>(null)
  const [dirtyMap, setDirtyMap] = useState<Record<string, DirtyEntry>>({})
  const [savingAll, setSavingAll] = useState(false)
  const [saveAllMsg, setSaveAllMsg] = useState<string | null>(null)
  // Preset apply broadcast: incrementing `version` triggers row editors
  // to adopt `values[row.key]`. Reset to a sentinel each apply so the
  // same preset can be re-fired (idempotent UX).
  const [presetState, setPresetState] = useState<PresetApplyState>({ values: {}, version: 0 })
  const applyPreset = useCallback((values: Record<string, string>) => {
    setPresetState((prev) => ({ values, version: prev.version + 1 }))
  }, [])

  const trackDirty = useCallback(
    (key: string, value: string | null, hasError: boolean, row: EnvRow) => {
      setDirtyMap((prev) => {
        // value=null means "row no longer dirty" — drop it from the map.
        if (value === null) {
          if (!(key in prev)) return prev
          const next = { ...prev }
          delete next[key]
          return next
        }
        const existing = prev[key]
        if (existing && existing.value === value && existing.hasError === hasError) {
          return prev
        }
        return { ...prev, [key]: { value, row, hasError } }
      })
    },
    [],
  )

  const dirtyEntries = Object.entries(dirtyMap)
  const dirtyCount = dirtyEntries.length
  const invalidCount = dirtyEntries.filter(([, e]) => e.hasError).length
  const saveableCount = dirtyCount - invalidCount

  const handleSaveAll = async () => {
    if (saveableCount === 0 || savingAll) return
    setSavingAll(true)
    setSaveAllMsg(null)
    let ok = 0
    const failures: { key: string; reason: string }[] = []
    // Series instead of parallel to avoid hammering corn-api + keep audit
    // ordering deterministic. 18 keys max so latency is fine.
    for (const [key, entry] of dirtyEntries) {
      if (entry.hasError) continue
      try {
        await updateSystemSetting(key, {
          value: entry.value === '' ? null : entry.value,
          isSecret: entry.row.isSecret,
          category: entry.row.category,
          description: entry.row.description,
          ...(entry.row.defaultValue !== undefined ? { defaultValue: entry.row.defaultValue } : {}),
        })
        ok++
      } catch (e: any) {
        failures.push({ key, reason: e?.message?.replace(/^API \d+: /, '') || 'failed' })
      }
    }
    setSavingAll(false)
    if (failures.length === 0) {
      setSaveAllMsg(`✓ Saved ${ok} setting(s) · hot-reload ≤60s`)
    } else {
      setSaveAllMsg(`Saved ${ok} · ${failures.length} failed: ${failures.map((f) => `${f.key} (${f.reason})`).join(', ')}`)
    }
    refresh()
    // Bust per-key audit caches so History modals show the new entries.
    void mutate((k) => typeof k === 'string' && k.startsWith('sys-audit:'), undefined, { revalidate: false })
  }

  const handleDiscardAll = async () => {
    if (dirtyCount === 0) return
    const ok = await confirm({
      title: 'Discard unsaved changes',
      message: `Discard ${dirtyCount} unsaved change(s)? Edited values will be reverted to the saved row.`,
      variant: 'warning',
      confirmLabel: 'Discard',
    })
    if (!ok) return
    // Reset by forcing a refresh — SettingRowEditor's effect on row.row
    // resets localValue. Map will clear on its own as rows report not-dirty.
    setDirtyMap({})
    setSaveAllMsg(null)
    refresh()
  }

  const handleMigrate = async () => {
    const ok = await confirm({
      title: 'Migrate env → DB',
      message: `Migrate ${unseeded} unseeded key(s) from process.env into the DB?\n\nExisting DB rows will be kept (idempotent).`,
      variant: 'default',
      confirmLabel: 'Migrate',
    })
    if (!ok) return
    setMigrateRunning(true)
    setMigrateMsg(null)
    try {
      const r = await migrateSystemSettingsFromEnv()
      setMigrateMsg(`Migrated ${r.migrated.length} key(s) · skipped ${r.skipped.length}`)
      refresh()
    } catch (e: any) {
      setMigrateMsg(e.message?.replace(/^API \d+: /, '') || 'Migration failed')
    } finally {
      setMigrateRunning(false)
    }
  }

  if (loading) {
    return <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>Loading settings…</div>
  }

  const categories = Object.keys(grouped).sort()

  return (
    <>
      {unseeded > 0 && (
        <div
          className="card"
          style={{
            marginBottom: 'var(--space-5)',
            borderColor: 'rgba(251,191,36,0.4)',
            background: 'rgba(251,191,36,0.06)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                🪄 {unseeded} setting(s) still live only in <code>.env</code>
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                One-click copy current <code>process.env</code> values into the DB so they become editable here. Existing DB rows are kept — idempotent.
              </div>
            </div>
            <button className="btn btn-primary" onClick={handleMigrate} disabled={migrateRunning}>
              {migrateRunning ? 'Migrating…' : 'Migrate env → DB'}
            </button>
          </div>
          {migrateMsg && (
            <div style={{ marginTop: 'var(--space-3)', fontSize: '0.85rem', color: 'var(--corn-gold)' }}>{migrateMsg}</div>
          )}
        </div>
      )}

      {/* Save-All sticky panel — only when something is actually dirty. */}
      {dirtyCount > 0 && (
        <div
          className="card"
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            marginBottom: 'var(--space-4)',
            borderColor: invalidCount > 0 ? 'rgba(239,68,68,0.4)' : 'rgba(34,197,94,0.4)',
            background: invalidCount > 0 ? 'rgba(239,68,68,0.06)' : 'rgba(34,197,94,0.06)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-4)',
              flexWrap: 'wrap',
            }}
          >
            <div>
              <div style={{ fontWeight: 600 }}>
                ✏️ {dirtyCount} unsaved change{dirtyCount > 1 ? 's' : ''}
                {invalidCount > 0 && (
                  <span style={{ color: 'var(--corn-red)', marginLeft: 8 }}>
                    · {invalidCount} with validation error{invalidCount > 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                {Object.keys(dirtyMap).map((k) => (
                  <code key={k} style={{ marginRight: 8, color: 'var(--corn-gold)' }}>{k}</code>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <button
                className="btn btn-secondary"
                onClick={handleDiscardAll}
                disabled={savingAll}
                title="Reset all dirty rows back to their saved value"
              >
                Discard
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSaveAll}
                disabled={saveableCount === 0 || savingAll}
                title={
                  saveableCount === 0
                    ? 'Fix validation errors before saving'
                    : `Save ${saveableCount} change(s) in one go`
                }
              >
                {savingAll ? `Saving ${saveableCount}…` : `💾 Save All (${saveableCount})`}
              </button>
            </div>
          </div>
          {saveAllMsg && (
            <div
              style={{
                marginTop: 'var(--space-3)',
                fontSize: '0.85rem',
                color: saveAllMsg.startsWith('✓') ? 'var(--corn-green)' : 'var(--corn-red)',
              }}
            >
              {saveAllMsg}
            </div>
          )}
        </div>
      )}
      {/* Show save-all summary even after the dirty panel collapses. */}
      {dirtyCount === 0 && saveAllMsg && (
        <div
          className="card"
          style={{
            marginBottom: 'var(--space-4)',
            borderColor: saveAllMsg.startsWith('✓') ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)',
            background: saveAllMsg.startsWith('✓') ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '0.85rem',
              color: saveAllMsg.startsWith('✓') ? 'var(--corn-green)' : 'var(--corn-red)',
            }}
          >
            <span>{saveAllMsg}</span>
            <button className="btn btn-secondary btn-sm" onClick={() => setSaveAllMsg(null)}>Dismiss</button>
          </div>
        </div>
      )}

      {categories.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No settings registered.</div>
      ) : (
        <PresetApplyContext.Provider value={presetState}>
          {categories.map((cat) => (
            <CategorySection
              key={cat}
              category={cat}
              rows={grouped[cat]!}
              onDirtyChange={trackDirty}
              onApplyPreset={cat === 'embedding' ? applyPreset : undefined}
              onChanged={() => {
                refresh()
                // The key-scoped audit list also caches; bust it on any change.
                void mutate((k) => typeof k === 'string' && k.startsWith('sys-audit:'), undefined, { revalidate: false })
              }}
            />
          ))}
        </PresetApplyContext.Provider>
      )}
    </>
  )
}

function CategorySection({
  category,
  rows,
  onChanged,
  onDirtyChange,
  onApplyPreset,
}: {
  category: string
  rows: EnvRow[]
  onChanged: () => void
  onDirtyChange: (key: string, value: string | null, hasError: boolean, row: EnvRow) => void
  /** Only the embedding category receives this — drives the preset dropdown. */
  onApplyPreset?: (values: Record<string, string>) => void
}) {
  return (
    <div className="card" style={{ marginBottom: 'var(--space-5)' }}>
      <h3 style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 'var(--space-4)', textTransform: 'capitalize', color: 'var(--corn-gold)' }}>
        {category} <span style={{ color: 'var(--text-muted)', fontWeight: 500, fontSize: '0.8rem' }}>({rows.length})</span>
      </h3>
      {onApplyPreset && (
        <EmbeddingProviderPicker
          onApply={onApplyPreset}
          currentProviderId={
            // Surface the saved provider_id so the picker can highlight
            // the currently-active row. Read the value as-is (not masked
            // — provider_id is non-secret) and treat '' as null.
            (() => {
              const r = rows.find((x) => x.key === 'embedding.provider_id')
              const v = r?.row?.value_masked || ''
              return v && r?.row?.value_set ? v : null
            })()
          }
        />
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {rows.map((r) => (
          <SettingRowEditor key={r.key} row={r} onChanged={onChanged} onDirtyChange={onDirtyChange} />
        ))}
      </div>
    </div>
  )
}

// ─── Embedding provider picker ──────────────────────────
// Replaces the old hardcoded EMBEDDING_PRESETS dropdown. Pulls live rows
// from /api/providers/embedding-candidates so the admin selects an actual
// configured Provider Account row (with their real api_base + key). The
// backend resolver then reads from `provider_accounts` on every request,
// overriding the 4 manual fallback fields.
//
// Actions:
//   • Picking a provider → sets `embedding.provider_id` dirty + applies
//     hint values into the api_base/model/dims fields (visual reference;
//     not authoritative — backend reads provider live).
//   • "Manual config" option → clears `embedding.provider_id` so the
//     legacy 4-key path takes over.
//
// Lives at the top of the embedding category section. Other categories
// don't render it (passed via `onApplyPreset` from EnvironmentTab).
function EmbeddingProviderPicker({
  onApply,
  currentProviderId,
}: {
  onApply: (values: Record<string, string>) => void
  currentProviderId: string | null
}) {
  const { data, isLoading, error } = useSWR('embedding-candidates', getEmbeddingCandidates, { revalidateOnFocus: false })
  const providers = data?.providers ?? []
  // Initialise from server state so users land on the currently-active
  // row without needing to re-pick after refresh. Use the saved provider
  // id when it matches a known row; otherwise leave the action dropdown
  // empty (the live setting will still show in the row editor below).
  const [selected, setSelected] = useState<string>('')
  useEffect(() => {
    if (!currentProviderId) {
      setSelected('')
      return
    }
    // Only auto-select when the providers list has loaded AND the id
    // matches something — otherwise '' keeps the dropdown neutral.
    if (providers.find((p: any) => p.id === currentProviderId)) {
      setSelected(currentProviderId)
    }
  }, [currentProviderId, providers])
  const [appliedNote, setAppliedNote] = useState<string | null>(null)

  const handleChange = (value: string) => {
    setSelected(value)
    setAppliedNote(null)
    if (value === '') {
      // No-op until user actively picks something.
      return
    }
    if (value === '__manual__') {
      // Clear `embedding.provider_id` so /embedding-config falls back to
      // the 4 manual keys. The 4 fields keep whatever they had on the
      // server — user can edit them directly below.
      onApply({ 'embedding.provider_id': '' })
      setAppliedNote('Provider link cleared. The 4 manual fields below are now authoritative — edit them directly + Save All.')
      return
    }
    const p = providers.find((row: any) => row.id === value)
    if (!p) return
    // Set provider_id + mirror api_base/model/dims into the manual fields
    // for visibility. Server-side, the manual fields are IGNORED whenever
    // `embedding.provider_id` is set — these are reference values only.
    const firstModel = Array.isArray(p.models) && p.models.length > 0 ? p.models[0] : ''
    onApply({
      'embedding.provider_id': value,
      'embedding.api_base': p.api_base || '',
      'embedding.model': firstModel,
      'embedding.dims': typeof p.dims === 'number' ? String(p.dims) : '',
    })
    setAppliedNote(`Linked to provider "${p.name}" (${p.api_base}). Click Save All to activate.`)
  }

  const selectedProvider = selected && selected !== '__manual__'
    ? providers.find((p: any) => p.id === selected)
    : null

  return (
    <div
      style={{
        marginBottom: 'var(--space-4)',
        padding: 'var(--space-3) var(--space-4)',
        background: 'rgba(251,191,36,0.06)',
        border: '1px solid rgba(251,191,36,0.2)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <div style={{ flex: '0 0 auto' }}>
          <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--corn-gold)', marginBottom: 2 }}>
            ⚡ Active embedding provider
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            Link a Provider Account (capability=embedding) to drive Mem9. Manage providers at <code>/providers</code>.
          </div>
        </div>
        <select
          className="input"
          value={selected}
          onChange={(e) => handleChange(e.target.value)}
          disabled={isLoading || !!error}
          style={{ flex: '1 1 260px', minWidth: 260, maxWidth: 380 }}
        >
          <option value="">— Choose action —</option>
          {providers.length === 0 && !isLoading && (
            <option value="" disabled>No embedding-capable providers yet</option>
          )}
          {providers.map((p: any) => (
            <option key={p.id} value={p.id}>
              {(p.type === 'openai' ? '🟢' : p.type === 'anthropic' ? '🟣' : p.type === 'ollama' ? '🦙' : '⚙️')} {p.name} · {p.api_base}{typeof p.dims === 'number' ? ` · ${p.dims}d` : ''}
            </option>
          ))}
          <option value="__manual__">🔧 Manual config (clear link, use the 4 fields below)</option>
        </select>
      </div>
      {error && (
        <div style={{ marginTop: 'var(--space-2)', fontSize: '0.78rem', color: '#f87171' }}>
          ⚠ Failed to load providers: {String((error as any)?.message || error)}
        </div>
      )}
      {!isLoading && !error && providers.length === 0 && (
        <div style={{ marginTop: 'var(--space-2)', fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          💡 No embedding-capable providers configured yet. Head to <code>/providers</code> → Add Provider → enable <strong>Embedding</strong> capability + set <strong>Dimensions</strong>. Then come back here.
        </div>
      )}
      {selectedProvider && (
        <div style={{ marginTop: 'var(--space-2)', fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          🔍 Will use <code>{selectedProvider.api_base}</code> with model <code>{Array.isArray(selectedProvider.models) && selectedProvider.models[0] ? selectedProvider.models[0] : '(none — falls back to manual)'}</code> and <code>{typeof selectedProvider.dims === 'number' ? `${selectedProvider.dims}d` : '(no dims — falls back to manual)'}</code>.
        </div>
      )}
      {appliedNote && (
        <div style={{ marginTop: 'var(--space-2)', fontSize: '0.78rem', color: 'var(--corn-green)', fontWeight: 500 }}>
          ✓ {appliedNote}
        </div>
      )}
    </div>
  )
}

// ─── Single row editor ──────────────────────────────────
function SettingRowEditor({
  row,
  onChanged,
  onDirtyChange,
}: {
  row: EnvRow
  onChanged: () => void
  onDirtyChange: (key: string, value: string | null, hasError: boolean, row: EnvRow) => void
}) {
  const confirm = useConfirm()
  const initial = row.row?.value_set ? row.row.value_masked : ''
  const [localValue, setLocalValue] = useState(initial)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [revealError, setRevealError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [auditOpen, setAuditOpen] = useState(false)

  // Reset local state when the underlying row changes (e.g. after migrate or save-all)
  useEffect(() => {
    setLocalValue(row.row?.value_set ? row.row.value_masked : '')
    setRevealed(null)
    setRevealError(null)
    setSaveMsg(null)
  }, [row.key, row.row?.value_masked, row.row?.value_set])

  // Adopt preset values from the embedding provider dropdown. Watching
  // `version` (not `values`) so re-applying the same preset re-fires
  // the fill — useful when the user nudged a field then wants to
  // restore from preset. Cancels any active reveal so the masked input
  // toggles back to displaying the new value verbatim.
  const presetCtx = useContext(PresetApplyContext)
  useEffect(() => {
    if (presetCtx.version === 0) return
    const incoming = presetCtx.values[row.key]
    if (incoming === undefined) return
    setLocalValue(incoming)
    setRevealed(null)
    setSaveMsg(null)
    // Intentionally omit `presetCtx.values` from deps — we only re-fire
    // when version increments (i.e. user picked a new preset), not on
    // every render where the values reference happens to be new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetCtx.version])

  // Auto re-mask after 60s for safety.
  useEffect(() => {
    if (revealed === null) return
    const t = setTimeout(() => setRevealed(null), 60_000)
    return () => clearTimeout(t)
  }, [revealed])

  const badge = sourceBadge(row.row)
  const dirty = localValue !== initial

  const validate = useCallback((val: string): string | null => {
    if (row.key === 'embedding.dims' || row.key === 'session.auto_close_minutes') {
      if (val && !/^\d+$/.test(val)) return 'must be a positive integer'
    }
    if (row.key === 'mail.port') {
      const n = Number(val)
      if (val && (!Number.isInteger(n) || n < 1 || n > 65535)) return 'must be 1–65535'
    }
    if (row.key === 'auth.cors_origin' || row.key === 'embedding.api_base') {
      if (val && !/^https?:\/\//.test(val)) return 'should start with http:// or https://'
    }
    if (row.key === 'llm.default_models') {
      if (val) {
        try { JSON.parse(val) } catch { return 'must be valid JSON' }
      }
    }
    return null
  }, [row.key])

  const validationError = validate(localValue)

  // Report dirty state up to EnvironmentTab so the Save-All panel can
  // drive a batch save. Strict equality of `value` keeps the parent's
  // setState short-circuit hot.
  useEffect(() => {
    if (dirty) {
      onDirtyChange(row.key, localValue, !!validationError, row)
    } else {
      onDirtyChange(row.key, null, false, row)
    }
  }, [dirty, localValue, validationError, row, onDirtyChange])

  const handleReveal = async () => {
    setRevealError(null)
    try {
      const r = await revealSystemSetting(row.key)
      setRevealed(r.value ?? '')
    } catch (e: any) {
      setRevealError(e.message?.replace(/^API \d+: /, '') || 'Reveal failed')
    }
  }

  const handleSave = async () => {
    if (validationError) return
    setSaving(true)
    setSaveMsg(null)
    try {
      await updateSystemSetting(row.key, {
        value: localValue === '' ? null : localValue,
        isSecret: row.isSecret,
        category: row.category,
        description: row.description,
        ...(row.defaultValue !== undefined ? { defaultValue: row.defaultValue } : {}),
      })
      setSaveMsg('Saved ✓ (hot-reload ≤60s)')
      onChanged()
    } catch (e: any) {
      setSaveMsg(e.message?.replace(/^API \d+: /, '') || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    const ok = await confirm({
      title: 'Clear DB override',
      message: `Clear DB override for "${row.key}"?\n\nNext read will fall back to env (or null).`,
      variant: 'warning',
      confirmLabel: 'Clear',
    })
    if (!ok) return
    setSaving(true)
    setSaveMsg(null)
    try {
      await updateSystemSetting(row.key, {
        value: null,
        isSecret: row.isSecret,
        category: row.category,
      })
      setSaveMsg('Cleared ✓')
      setLocalValue('')
      setRevealed(null)
      onChanged()
    } catch (e: any) {
      setSaveMsg(e.message?.replace(/^API \d+: /, '') || 'Clear failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      style={{
        padding: 'var(--space-3) var(--space-4)',
        background: 'var(--bg-input)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-4)', marginBottom: 'var(--space-2)', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 300px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <code style={{ color: 'var(--corn-gold)', fontSize: '0.9rem' }}>{row.key}</code>
            <span className={`badge ${badge.cls}`}>{badge.label}</span>
            {row.isSecret && <span className="badge badge-warning">secret</span>}
            {row.envVar && (
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                env: <code>{row.envVar}</code>
              </span>
            )}
          </div>
          {row.description && (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>{row.description}</div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <input
          className="input"
          style={{ flex: '1 1 300px', minWidth: 200 }}
          value={revealed ?? localValue}
          placeholder={row.defaultValue ? `default: ${row.defaultValue}` : '(empty)'}
          onChange={(e) => {
            setRevealed(null)  // cancel reveal state on edit
            setLocalValue(e.target.value)
          }}
          type={row.isSecret && revealed === null ? 'password' : 'text'}
        />

        {row.isSecret && row.row?.value_set && (
          <button className="btn btn-secondary btn-sm" onClick={handleReveal} title="Show plaintext for 60s (rate-limited, audited)">
            {revealed !== null ? '👁 Showing' : '🔓 Reveal'}
          </button>
        )}
        <button
          className="btn btn-primary btn-sm"
          onClick={handleSave}
          disabled={!dirty || saving || !!validationError}
          title={
            !dirty
              ? 'No changes to save — edit the value first'
              : validationError
                ? `Fix validation: ${validationError}`
                : saving
                  ? 'Saving…'
                  : 'Save this row to DB (hot-reload ≤60s)'
          }
          style={!dirty || saving || !!validationError ? { cursor: 'not-allowed', opacity: 0.5 } : undefined}
        >
          {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
        {row.row?.value_set && (
          <button className="btn btn-secondary btn-sm" onClick={handleClear} disabled={saving} title="Remove DB override — fall back to env">
            Clear
          </button>
        )}
        <button className="btn btn-secondary btn-sm" onClick={() => setAuditOpen(true)}>
          History
        </button>
      </div>

      {validationError && (
        <div style={{ marginTop: 'var(--space-2)', fontSize: '0.8rem', color: 'var(--corn-red)' }}>⚠ {validationError}</div>
      )}
      {revealError && (
        <div style={{ marginTop: 'var(--space-2)', fontSize: '0.8rem', color: 'var(--corn-red)' }}>{revealError}</div>
      )}
      {saveMsg && (
        <div style={{ marginTop: 'var(--space-2)', fontSize: '0.8rem', color: saveMsg.includes('✓') ? 'var(--corn-green)' : 'var(--corn-red)' }}>{saveMsg}</div>
      )}
      {revealed !== null && (
        <div style={{ marginTop: 'var(--space-2)', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          Plaintext shown for 60s · auto-mask on timer
        </div>
      )}

      {auditOpen && <AuditModal keyName={row.key} onClose={() => setAuditOpen(false)} />}
    </div>
  )
}

// ─── Audit modal (per-key) ──────────────────────────────
function AuditModal({ keyName, onClose }: { keyName: string; onClose: () => void }) {
  const { data, isLoading } = useSWR(`sys-audit:${keyName}`, () => getSystemSettingAudit(keyName, 50))
  const entries = data?.entries ?? []
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-4)',
    }}
      onClick={onClose}
    >
      <div className="card animate-in" style={{ width: '100%', maxWidth: 720, maxHeight: '80vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-4)' }}>
          <h3 style={{ fontWeight: 700 }}>
            History · <code style={{ color: 'var(--corn-gold)' }}>{keyName}</code>
          </h3>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
        </div>
        {isLoading ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 'var(--space-6)' }}>Loading…</div>
        ) : entries.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 'var(--space-6)' }}>No history for this key yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
                {['When', 'By', 'Action', 'Old', 'New'].map((h) => (
                  <th key={h} style={{ padding: 'var(--space-2) var(--space-3)', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', fontSize: '0.7rem', letterSpacing: '0.05em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((e: SystemSettingAudit) => (
                <tr key={e.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: 'var(--space-2) var(--space-3)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{formatLocalDate(e.changed_at)}</td>
                  <td style={{ padding: 'var(--space-2) var(--space-3)', color: 'var(--text-secondary)' }}>{e.changed_by ?? '—'}</td>
                  <td style={{ padding: 'var(--space-2) var(--space-3)' }}>
                    <span className={`badge ${e.action === 'reveal' ? 'badge-info' : 'badge-warning'}`}>{e.action}</span>
                  </td>
                  <td style={{ padding: 'var(--space-2) var(--space-3)', fontFamily: 'monospace', fontSize: '0.8rem', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.old_value ?? <em style={{ color: 'var(--text-muted)' }}>null</em>}</td>
                  <td style={{ padding: 'var(--space-2) var(--space-3)', fontFamily: 'monospace', fontSize: '0.8rem', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.new_value ?? <em style={{ color: 'var(--text-muted)' }}>null</em>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ─── Audit tab (all keys aggregated) ────────────────────
function AuditTab({ rows }: { rows: EnvRow[] }) {
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <div className="card">
      <h3 style={{ fontWeight: 700, marginBottom: 'var(--space-3)' }}>Per-key audit log</h3>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 'var(--space-4)' }}>
        Pick a key to see its last 50 changes. Secrets are stored as <code>••••last4</code> masks — raw values never appear in audit.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
        {rows
          .filter((r) => r.row)
          .map((r) => (
            <button
              key={r.key}
              className="btn btn-secondary btn-sm"
              onClick={() => setSelected(r.key)}
            >
              <code>{r.key}</code>
            </button>
          ))}
      </div>
      {selected && <AuditModal keyName={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

