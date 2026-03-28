'use client'
import { useState } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { getProviders, createProvider, deleteProvider } from '@/lib/api'

export default function ProvidersPage() {
  const { data, mutate } = useSWR('providers', getProviders, { refreshInterval: 30000 })
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState('openai')
  const [apiBase, setApiBase] = useState('')
  const [apiKey, setApiKey] = useState('')

  const handleCreate = async () => {
    if (!name.trim() || !apiBase.trim()) return
    await createProvider({ name, type, apiBase, apiKey: apiKey || undefined })
    setName(''); setType('openai'); setApiBase(''); setApiKey(''); setShowForm(false)
    mutate()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this provider?')) return
    await deleteProvider(id)
    mutate()
  }

  return (
    <DashboardLayout title="Providers" subtitle="Configure LLM providers for model routing">
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--space-4)' }}>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancel' : '+ Add Provider'}
        </button>
      </div>

      {showForm && (
        <div className="card animate-in" style={{ marginBottom: 'var(--space-6)' }}>
          <h3 style={{ fontWeight: 600, marginBottom: 'var(--space-4)' }}>New Provider</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <input className="input" placeholder="Provider name (e.g., OpenAI, Anthropic)" value={name} onChange={(e) => setName(e.target.value)} />
            <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
              <select className="input" value={type} onChange={(e) => setType(e.target.value)} style={{ flex: 1 }}>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="openrouter">OpenRouter</option>
                <option value="ollama">Ollama</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <input className="input" placeholder="API Base URL (e.g., https://api.openai.com/v1)" value={apiBase} onChange={(e) => setApiBase(e.target.value)} />
            <input className="input" placeholder="API Key (optional — stored encrypted)" value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" />
            <button className="btn btn-primary" onClick={handleCreate} style={{ alignSelf: 'flex-start' }}>Add Provider</button>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 'var(--space-4)' }}>
        {data?.providers && data.providers.length > 0 ? (
          data.providers.map((p: any) => {
            const capabilities = (() => { try { return JSON.parse(p.capabilities || '[]') } catch { return [] } })()
            const models = (() => { try { return JSON.parse(p.models || '[]') } catch { return [] } })()
            return (
              <div key={p.id} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <h3 style={{ fontWeight: 600, fontSize: '1.05rem' }}>🧠 {p.name}</h3>
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
                  <div style={{ marginTop: 'var(--space-3)', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Models: {models.join(', ')}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-4)' }}>
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
