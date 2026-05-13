'use client'
import { useState } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { getProviders, createProvider, deleteProvider, updateProvider } from '@/lib/api'
import { useConfirm, useToast } from '@/components/ConfirmProvider'

const PROVIDER_TYPES = [
  { value: 'openai', label: '🟢 OpenAI', icon: '🟢' },
  { value: 'anthropic', label: '🟣 Anthropic', icon: '🟣' },
  { value: 'copilot', label: '⭐ GitHub Copilot', icon: '⭐' },
  { value: 'github-models', label: '🐙 GitHub Models', icon: '🐙' },
  { value: 'openrouter', label: '🔀 OpenRouter', icon: '🔀' },
  { value: 'ollama', label: '🦙 Ollama (local)', icon: '🦙' },
  { value: 'custom', label: '⚙️ Custom', icon: '⚙️' },
]

const PRESETS: Record<string, { apiBase: string; keyLabel: string; models: string[] }> = {
  openai: { apiBase: 'https://api.openai.com/v1', keyLabel: 'OpenAI API Key', models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'] },
  anthropic: { apiBase: 'https://api.anthropic.com/v1', keyLabel: 'Anthropic API Key', models: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-3-7-sonnet'] },
  copilot: { apiBase: 'https://api.githubcopilot.com/v1', keyLabel: 'GitHub Token / PAT', models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'claude-3.7-sonnet', 'claude-sonnet-4-5'] },
  'github-models': { apiBase: 'https://models.inference.ai.azure.com', keyLabel: 'GitHub Token / PAT', models: ['gpt-4o', 'gpt-4.5-turbo', 'Meta-Llama-3.1-70B-Instruct', 'Mistral-large-2411', 'DeepSeek-V3'] },
  openrouter: { apiBase: 'https://openrouter.ai/api/v1', keyLabel: 'OpenRouter API Key', models: [] },
  ollama: { apiBase: 'http://localhost:11434/v1', keyLabel: 'API Key (leave blank for Ollama)', models: ['llama3.2', 'qwen2.5-coder', 'deepseek-r1'] },
}

const TYPE_ICONS: Record<string, string> = { openai: '🟢', anthropic: '🟣', copilot: '⭐', 'github-models': '🐙', openrouter: '🔀', ollama: '🦙', custom: '⚙️' }

// Known capability tokens. 'chat' = LLM completion (default); 'embedding' =
// embedding vector generation (requires `dims`). A provider can carry both.
const CAPABILITY_OPTIONS = [
  { value: 'chat', label: '💬 Chat (LLM)', hint: 'For corn_chat / LLM gateway routing' },
  { value: 'embedding', label: '🔍 Embedding', hint: 'For corn_memory_* / Mem9. Requires Dimensions.' },
] as const

export default function ProvidersPage() {
  const { data, mutate } = useSWR('providers', getProviders, { refreshInterval: 30000 })
  const confirm = useConfirm()
  const toast = useToast()
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [type, setType] = useState('openai')
  const [apiBase, setApiBase] = useState(PRESETS.openai.apiBase)
  const [apiKey, setApiKey] = useState('')
  const [modelsInput, setModelsInput] = useState(PRESETS.openai.models.join(', '))
  const [capabilities, setCapabilities] = useState<string[]>(['chat'])
  const [dimsInput, setDimsInput] = useState<string>('')
  const [formError, setFormError] = useState<string | null>(null)

  const resetForm = () => {
    setName(''); setType('openai'); setApiBase(PRESETS.openai.apiBase); setApiKey(''); setModelsInput(PRESETS.openai.models.join(', '))
    setCapabilities(['chat'])
    setDimsInput('')
    setFormError(null)
    setEditId(null); setShowForm(false)
  }

  const handleTypeChange = (t: string) => {
    setType(t)
    const preset = PRESETS[t]
    if (preset) {
      setApiBase(preset.apiBase)
      setModelsInput(preset.models.join(', '))
    } else {
      setApiBase('')
      setModelsInput('')
    }
  }

  const toggleCapability = (cap: string) => {
    setFormError(null)
    setCapabilities((prev) =>
      prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap],
    )
  }

  // Cross-field validation matches backend: embedding capability → dims required.
  const validateForm = (): string | null => {
    if (!name.trim()) return 'Name is required'
    if (!apiBase.trim()) return 'API Base URL is required'
    if (capabilities.length === 0) return 'Select at least one capability'
    if (capabilities.includes('embedding')) {
      const n = Number(dimsInput)
      if (!/^\d+$/.test(dimsInput) || !Number.isInteger(n) || n <= 0) {
        return 'Dimensions must be a positive integer when Embedding capability is enabled'
      }
    }
    return null
  }

  const handleCreate = async () => {
    const err = validateForm()
    if (err) { setFormError(err); return }
    const models = modelsInput.split(',').map((m) => m.trim()).filter(Boolean)
    const dims = capabilities.includes('embedding') ? Number(dimsInput) : null
    try {
      await createProvider({ name, type, apiBase, apiKey: apiKey || undefined, models, capabilities, dims })
      resetForm(); mutate()
    } catch (e: any) {
      setFormError(e?.message?.replace(/^API \d+: /, '') || 'Create failed')
    }
  }

  const handleEdit = (p: any) => {
    setEditId(p.id)
    setName(p.name)
    setType(p.type)
    setApiBase(p.api_base)
    setApiKey('')
    const models: string[] = Array.isArray(p.models) ? p.models : []
    setModelsInput(models.join(', '))
    const caps: string[] = Array.isArray(p.capabilities) && p.capabilities.length > 0 ? p.capabilities : ['chat']
    setCapabilities(caps)
    setDimsInput(typeof p.dims === 'number' ? String(p.dims) : '')
    setFormError(null)
    setShowForm(true)
  }

  const handleUpdate = async () => {
    if (!editId) return
    const err = validateForm()
    if (err) { setFormError(err); return }
    const models = modelsInput.split(',').map((m) => m.trim()).filter(Boolean)
    const dims = capabilities.includes('embedding') ? Number(dimsInput) : null
    try {
      await updateProvider(editId, { name, apiBase, apiKey: apiKey || undefined, models, capabilities, dims })
      resetForm(); mutate()
    } catch (e: any) {
      setFormError(e?.message?.replace(/^API \d+: /, '') || 'Update failed')
    }
  }

  const handleDelete = async (id: string) => {
    const ok = await confirm({
      title: 'Delete provider',
      message: 'Delete this provider? Tasks routed to it will fail until reconfigured.',
      variant: 'danger',
      confirmLabel: 'Delete',
    })
    if (!ok) return
    try {
      await deleteProvider(id)
      mutate()
      toast({ kind: 'success', message: 'Provider removed' })
    } catch (e: any) {
      toast({ kind: 'error', message: e?.message?.replace(/^API \d+: /, '') || 'Delete failed' })
    }
  }

  const preset = PRESETS[type]
  const keyLabel = preset?.keyLabel || 'API Key'

  return (
    <DashboardLayout title="Providers" subtitle="Configure LLM providers for model routing">
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--space-4)' }}>
        <button className="btn btn-primary" onClick={() => { if (showForm) resetForm(); else setShowForm(true) }}>
          {showForm ? 'Cancel' : '+ Add Provider'}
        </button>
      </div>

      {showForm && (
        <div className="card animate-in" style={{ marginBottom: 'var(--space-6)' }}>
          <h3 style={{ fontWeight: 600, marginBottom: 'var(--space-4)' }}>{editId ? 'Edit Provider' : 'New Provider'}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <input className="input" placeholder="Provider name (e.g., My OpenAI)" value={name} onChange={(e) => setName(e.target.value)} />
            <select className="input" value={type} onChange={(e) => handleTypeChange(e.target.value)}>
              {PROVIDER_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <input className="input" placeholder="API Base URL" value={apiBase} onChange={(e) => setApiBase(e.target.value)} />
            <input
              className="input"
              placeholder={editId ? `${keyLabel} (leave blank to keep existing key)` : `${keyLabel} (optional — stored encrypted)`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
            />
            <input
              className="input"
              placeholder="Models (comma-separated, e.g. gpt-4o, gpt-4o-mini)"
              value={modelsInput}
              onChange={(e) => setModelsInput(e.target.value)}
            />

            {/* Capabilities + dims — drives System Settings → Embedding picker */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Capabilities</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
                {CAPABILITY_OPTIONS.map((opt) => (
                  <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer', fontSize: '0.85rem' }}>
                    <input
                      type="checkbox"
                      checked={capabilities.includes(opt.value)}
                      onChange={() => toggleCapability(opt.value)}
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                {capabilities.includes('embedding')
                  ? '🔍 Embedding selected — set Dimensions below. This provider will appear in the System Settings → Embedding picker.'
                  : '💬 Chat-only — used for corn_chat / LLM routing.'}
              </div>
            </div>

            {capabilities.includes('embedding') && (
              <input
                className="input"
                placeholder="Dimensions (e.g. 1024 for bge-m3, 1536 for text-embedding-3-small)"
                value={dimsInput}
                onChange={(e) => { setDimsInput(e.target.value); setFormError(null) }}
                inputMode="numeric"
              />
            )}

            {(type === 'copilot' || type === 'github-models') && (
              <div style={{ background: 'var(--bg-accent)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3) var(--space-4)', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {type === 'copilot'
                  ? '⭐ Requires a GitHub Copilot Business/Enterprise subscription. Use a GitHub PAT with copilot scope.'
                  : '🐙 GitHub Models free tier — create a PAT at github.com/settings/tokens (no scopes needed).'}
              </div>
            )}

            {formError && (
              <div style={{ padding: 'var(--space-2) var(--space-3)', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', color: '#f87171' }}>
                ⚠ {formError}
              </div>
            )}

            <button className="btn btn-primary" onClick={editId ? handleUpdate : handleCreate} style={{ alignSelf: 'flex-start' }}>
              {editId ? 'Save Changes' : 'Add Provider'}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 'var(--space-4)' }}>
        {data?.providers && data.providers.length > 0 ? (
          data.providers.map((p: any) => {
            const capabilities: string[] = Array.isArray(p.capabilities) ? p.capabilities : []
            const models: string[] = Array.isArray(p.models) ? p.models : []
            const icon = TYPE_ICONS[p.type] || '🧠'
            return (
              <div key={p.id} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <h3 style={{ fontWeight: 600, fontSize: '1.05rem' }}>{icon} {p.name}</h3>
                    <code style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{p.type}</code>
                  </div>
                  <span className={`badge badge-${p.status === 'enabled' ? 'healthy' : 'error'}`}>{p.status}</span>
                </div>
                <code style={{ display: 'block', marginTop: 'var(--space-3)', fontSize: '0.75rem', color: 'var(--text-secondary)', wordBreak: 'break-all' }}>{p.api_base}</code>
                {p.api_key_set && (
                  <div style={{ marginTop: 'var(--space-2)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                    <span>🔑</span>
                    <code style={{ fontSize: '0.72rem' }}>{p.api_key_masked || '••••'}</code>
                    {p.api_key_encrypted === false && (
                      <span style={{ padding: '1px 6px', background: 'rgba(248,113,113,0.1)', color: '#f87171', borderRadius: '99px', fontSize: '0.65rem' }}>plaintext</span>
                    )}
                  </div>
                )}
                {(capabilities.length > 0 || typeof p.dims === 'number') && (
                  <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)', flexWrap: 'wrap' }}>
                    {capabilities.map((c: string) => (
                      <span key={c} style={{ padding: '2px 8px', background: 'var(--bg-accent)', borderRadius: '99px', fontSize: '0.7rem', color: 'var(--corn-gold)' }}>{c}</span>
                    ))}
                    {typeof p.dims === 'number' && p.dims > 0 && (
                      <span style={{ padding: '2px 8px', background: 'rgba(56,189,248,0.1)', borderRadius: '99px', fontSize: '0.7rem', color: '#38bdf8' }}>{p.dims}d</span>
                    )}
                  </div>
                )}
                {models.length > 0 && (
                  <div style={{ marginTop: 'var(--space-3)', fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                    {models.slice(0, 3).join(' · ')}{models.length > 3 ? ` +${models.length - 3} more` : ''}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
                  <button className="btn btn-sm" onClick={() => handleEdit(p)} style={{ background: 'var(--bg-accent)', border: '1px solid var(--border)' }}>✏️ Edit</button>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDelete(p.id)}>Remove</button>
                </div>
              </div>
            )
          })
        ) : (
          <div className="card" style={{ textAlign: 'center', padding: 'var(--space-10)', color: 'var(--text-muted)', gridColumn: '1 / -1' }}>
            🧠 No providers configured yet. Add an LLM provider to enable model routing.
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
