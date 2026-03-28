'use client'
import { useState } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { getApiKeys, createApiKey, deleteApiKey } from '@/lib/api'

export default function KeysPage() {
  const { data, mutate } = useSWR('keys', getApiKeys, { refreshInterval: 30000 })
  const [name, setName] = useState('')
  const [newKey, setNewKey] = useState<string | null>(null)

  const handleCreate = async () => {
    if (!name.trim()) return
    const result = await createApiKey({ name })
    setNewKey(result.key)
    setName('')
    mutate()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this API key?')) return
    await deleteApiKey(id)
    mutate()
  }

  return (
    <DashboardLayout title="API Keys" subtitle="Manage API keys for agent authentication">
      {/* Create form */}
      <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
        <h3 style={{ fontWeight: 600, marginBottom: 'var(--space-4)' }}>Generate New Key</h3>
        <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
          <input className="input" placeholder="Key name (e.g., Antigravity, Claude Code)" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
          <button className="btn btn-primary" onClick={handleCreate}>Generate</button>
        </div>
        {newKey && (
          <div style={{ marginTop: 'var(--space-4)', padding: 'var(--space-4)', background: 'var(--bg-input)', border: '1px solid var(--corn-gold)', borderRadius: 'var(--radius-md)' }}>
            <p style={{ color: 'var(--corn-gold)', fontWeight: 600, marginBottom: 'var(--space-2)' }}>⚠️ Save this key — it will not be shown again!</p>
            <code style={{ fontSize: '0.85rem', wordBreak: 'break-all', color: 'var(--text-primary)' }}>{newKey}</code>
          </div>
        )}
      </div>

      {/* Keys table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Scope</th>
              <th>Created</th>
              <th>Last Used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data?.keys && data.keys.length > 0 ? (
              data.keys.map((k: any) => (
                <tr key={k.id}>
                  <td><code style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{k.id}</code></td>
                  <td style={{ fontWeight: 600 }}>{k.name}</td>
                  <td><span className="badge badge-info">{k.scope}</span></td>
                  <td style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{new Date(k.created_at).toLocaleDateString()}</td>
                  <td style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : '—'}</td>
                  <td><button className="btn btn-danger btn-sm" onClick={() => handleDelete(k.id)}>Delete</button></td>
                </tr>
              ))
            ) : (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: 'var(--space-10)', color: 'var(--text-muted)' }}>
                🔑 No API keys yet. Generate one to connect your agents.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </DashboardLayout>
  )
}
