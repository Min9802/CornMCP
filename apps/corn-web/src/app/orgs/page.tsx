'use client'
import { useState } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { getOrganizations, createOrganization, updateOrganization, deleteOrganization } from '@/lib/api'

export default function OrgsPage() {
  const { data, mutate } = useSWR('orgs', getOrganizations, { refreshInterval: 30000 })
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')

  const resetForm = () => { setName(''); setDesc(''); setEditId(null); setShowForm(false) }

  const handleCreate = async () => {
    if (!name.trim()) return
    await createOrganization({ name, description: desc })
    resetForm(); mutate()
  }

  const handleUpdate = async () => {
    if (!editId || !name.trim()) return
    await updateOrganization(editId, { name, description: desc })
    resetForm(); mutate()
  }

  const handleEdit = (org: any) => {
    setEditId(org.id); setName(org.name); setDesc(org.description || ''); setShowForm(true)
  }

  const handleDelete = async (id: string, orgName: string) => {
    if (!confirm(`Delete organization "${orgName}"?`)) return
    await deleteOrganization(id); mutate()
  }

  return (
    <DashboardLayout title="Organizations" subtitle="Multi-tenant organization management">
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--space-4)' }}>
        <button className="btn btn-primary" onClick={() => { if (showForm) resetForm(); else setShowForm(true) }}>
          {showForm ? 'Cancel' : '+ New Organization'}
        </button>
      </div>

      {showForm && (
        <div className="card animate-in" style={{ marginBottom: 'var(--space-6)' }}>
          <h3 style={{ fontWeight: 600, marginBottom: 'var(--space-4)' }}>{editId ? 'Edit Organization' : 'New Organization'}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <input className="input" placeholder="Organization name" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="input" placeholder="Description (optional)" value={desc} onChange={(e) => setDesc(e.target.value)} />
            <button className="btn btn-primary" onClick={editId ? handleUpdate : handleCreate} style={{ alignSelf: 'flex-start' }}>
              {editId ? 'Save' : 'Create'}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 'var(--space-4)' }}>
        {data?.organizations?.map((org: any) => (
          <div key={org.id} className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
              <span style={{ fontSize: '1.5rem' }}>🏢</span>
              <div style={{ flex: 1 }}>
                <h3 style={{ fontWeight: 600, fontSize: '1.05rem' }}>{org.name}</h3>
                <code style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{org.slug}</code>
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <button onClick={() => handleEdit(org)} title="Edit" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', padding: 4 }}>✏️</button>
                <button onClick={() => handleDelete(org.id, org.name)} title="Delete" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', padding: 4 }}>🗑️</button>
              </div>
            </div>
            {org.description && (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{org.description}</p>
            )}
            <div style={{ marginTop: 'var(--space-3)', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Created: {new Date(org.created_at).toLocaleDateString()}
            </div>
          </div>
        ))}
      </div>
    </DashboardLayout>
  )
}
