'use client'
import { useState } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { getProviders, createProvider, deleteProvider, updateProvider } from '@/lib/api'

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

export default function ProvidersPage() {
  const { data, mutate } = useSWR('providers', getProviders, { refreshInterval: 30000 })
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [type, setType] = useState('openai')
  const [apiBase, setApiBase] = useState(PRESETS.openai.apiBase)
  const [apiKey, setApiKey] = useState('')
  const [modelsInput, setModelsInput] = useState(PRESETS.openai.models.join(', '))

  const resetForm = () => {
    setName(''); setType('openai'); setApiBase(PRESETS.openai.apiBase); setApiKey(''); setModelsInput(PRESETS.openai.models.join(', '))
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

  const handleCreate = async () => {
    if (!name.trim() || !apiBase.trim()) return
    const models = modelsInput.split(',').map((m) => m.trim()).filter(Boolean)
    await createProvider({ name, type, apiBase, apiKey: apiKey || undefined, models })
    resetForm(); mutate()
  }

  const handleEdit = (p: any) => {
    setEditId(p.id)
    setName(p.name)
    setType(p.type)
    setApiBase(p.api_base)
    setApiKey('')
    const models = (() => { try { return JSON.parse(p.models || '[]') } catch { return [] } })()
    setModelsInput(models.join(', '))
    setShowForm(true)
  }

  const handleUpdate = async () => {
    if (!editId || !name.trim()) return
    const models = modelsInput.split(',').map((m) => m.trim()).filter(Boolean)
    await updateProvider(editId, { name, apiBase, apiKey: apiKey || undefined, models })
    resetForm(); mutate()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this provider?')) return
    await deleteProvider(id)
    mutate()
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
              placeholder={`${keyLabel} (optional — stored encrypted)`}
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
            {(type === 'copilot' || type === 'github-models') && (
              <div style={{ background: 'var(--bg-accent)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3) var(--space-4)', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {type === 'copilot'
                  ? '⭐ Requires a GitHub Copilot Business/Enterprise subscription. Use a GitHub PAT with copilot scope.'
                  : '🐙 GitHub Models free tier — create a PAT at github.com/settings/tokens (no scopes needed).'}
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
            const capabilities = (() => { try { return JSON.parse(p.capabilities || '[]') } catch { return [] } })()
            const models = (() => { try { return JSON.parse(p.models || '[]') } catch { return [] } })()
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
                {capabilities.length > 0 && (
                  <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)', flexWrap: 'wrap' }}>
                    {capabilities.map((c: string) => (
                      <span key={c} style={{ padding: '2px 8px', background: 'var(--bg-accent)', borderRadius: '99px', fontSize: '0.7rem', color: 'var(--corn-gold)' }}>{c}</span>
                    ))}
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
