'use client'
import { useState } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { getProjects, createProject, updateProject, deleteProject } from '@/lib/api'
import { formatLocalDate } from '@/lib/date'
import { useConfirm, useToast } from '@/components/ConfirmProvider'

export default function ProjectsPage() {
  const { data, mutate } = useSWR('projects', getProjects, { refreshInterval: 30000 })
  const confirm = useConfirm()
  const toast = useToast()
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [gitUrl, setGitUrl] = useState('')

  const resetForm = () => {
    setName(''); setDesc(''); setGitUrl(''); setEditId(null); setShowForm(false)
  }

  const handleCreate = async () => {
    if (!name.trim()) return
    await createProject({ name, description: desc, gitRepoUrl: gitUrl })
    resetForm(); mutate()
  }

  const handleUpdate = async () => {
    if (!editId || !name.trim()) return
    await updateProject(editId, { name, description: desc, gitRepoUrl: gitUrl })
    resetForm(); mutate()
  }

  const handleEdit = (p: any) => {
    setEditId(p.id)
    setName(p.name)
    setDesc(p.description || '')
    setGitUrl(p.git_repo_url || '')
    setShowForm(true)
  }

  const handleDelete = async (id: string, projectName: string) => {
    const ok = await confirm({
      title: 'Delete project',
      message: `Delete project "${projectName}"?\n\nThis will also remove all indexed symbols and jobs. Cannot be undone.`,
      variant: 'danger',
      confirmLabel: 'Delete project',
    })
    if (!ok) return
    try {
      await deleteProject(id)
      mutate()
      toast({ kind: 'success', message: `Deleted project "${projectName}"` })
    } catch (e: any) {
      toast({ kind: 'error', message: e?.message?.replace(/^API \d+: /, '') || 'Delete failed' })
    }
  }

  return (
    <DashboardLayout title="Projects" subtitle="Manage repositories and code intelligence">
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--space-4)' }}>
        <button className="btn btn-primary" onClick={() => { if (showForm) resetForm(); else setShowForm(true) }}>
          {showForm ? 'Cancel' : '+ New Project'}
        </button>
      </div>

      {showForm && (
        <div className="card animate-in" style={{ marginBottom: 'var(--space-6)' }}>
          <h3 style={{ fontWeight: 600, marginBottom: 'var(--space-4)' }}>{editId ? 'Edit Project' : 'New Project'}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <input className="input" placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="input" placeholder="Description (optional)" value={desc} onChange={(e) => setDesc(e.target.value)} />
            <input className="input" placeholder="Git repo URL (optional)" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} />
            <button className="btn btn-primary" onClick={editId ? handleUpdate : handleCreate} style={{ alignSelf: 'flex-start' }}>
              {editId ? 'Save' : 'Create'}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 'var(--space-4)' }}>
        {data?.projects && data.projects.length > 0 ? (
          data.projects.map((p: any) => (
            <div key={p.id} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--space-2)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3 style={{ fontWeight: 600, fontSize: '1.05rem' }}>{p.name}</h3>
                  {p.description && <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: 'var(--space-1)' }}>{p.description}</p>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  {p.git_repo_url && <span className="badge badge-info">Git</span>}
                  <button onClick={() => handleEdit(p)} title="Edit" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', padding: 4 }}>✏️</button>
                  <button onClick={() => handleDelete(p.id, p.name)} title="Delete" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', padding: 4 }}>🗑️</button>
                </div>
              </div>
              {p.git_repo_url && (
                <code style={{ display: 'block', marginTop: 'var(--space-3)', fontSize: '0.75rem', color: 'var(--text-muted)', wordBreak: 'break-all' }}>{p.git_repo_url}</code>
              )}
              <div style={{ display: 'flex', gap: 'var(--space-4)', marginTop: 'var(--space-4)', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                <span>🧬 {p.indexed_symbols || 0} symbols</span>
                <span>📅 {formatLocalDate(p.created_at)}</span>
              </div>
            </div>
          ))
        ) : (
          <div className="card" style={{ textAlign: 'center', padding: 'var(--space-10)', color: 'var(--text-muted)', gridColumn: '1 / -1' }}>
            📁 No projects yet. Create one to get started.
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
