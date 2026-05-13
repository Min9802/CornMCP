'use client'
import { useMemo, useState } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import {
  getOrganizations,
  createOrganization,
  updateOrganization,
  deleteOrganization,
  getUsers,
  type UserRecord,
} from '@/lib/api'
import { getMe } from '@/lib/auth'
import { formatLocalDate } from '@/lib/date'
import { useConfirm, useToast } from '@/components/ConfirmProvider'

export default function OrgsPage() {
  const { data, mutate } = useSWR('orgs', getOrganizations, { refreshInterval: 30000 })
  const { data: me } = useSWR('me', getMe)
  const isAdmin = me?.role === 'admin'
  // Only admins can list users (endpoint is admin-only). Skip the fetch
  // for regular users so we don't trigger a 403 in dev tools.
  const { data: usersData } = useSWR(isAdmin ? 'users' : null, getUsers)
  const users: UserRecord[] = usersData?.users || []
  const userMap = useMemo(() => {
    const m = new Map<string, UserRecord>()
    users.forEach((u) => m.set(u.id, u))
    return m
  }, [users])

  const confirm = useConfirm()
  const toast = useToast()
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  // Empty string = "Assign to me (admin)". Only used when isAdmin.
  const [ownerId, setOwnerId] = useState('')
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  const resetForm = () => {
    setName('')
    setDesc('')
    setOwnerId('')
    setEditId(null)
    setFormError('')
    setShowForm(false)
  }

  const ownerLabel = (uid: string | null | undefined) => {
    if (!uid) return 'Unassigned'
    const u = userMap.get(uid)
    if (u) return `${u.name} (${u.email})`
    if (me && uid === me.id) return `${me.name} (${me.email})`
    return uid
  }

  const handleSubmit = async () => {
    if (!name.trim()) {
      setFormError('Organization name is required')
      return
    }
    setSaving(true)
    setFormError('')
    try {
      if (editId) {
        const payload: { name: string; description: string; userId?: string } = {
          name,
          description: desc,
        }
        if (isAdmin) payload.userId = ownerId // '' = reassign to current admin
        await updateOrganization(editId, payload)
        toast({ kind: 'success', message: `Updated organization "${name}"` })
      } else {
        const payload: { name: string; description: string; userId?: string } = {
          name,
          description: desc,
        }
        if (isAdmin) payload.userId = ownerId
        await createOrganization(payload)
        toast({ kind: 'success', message: `Created organization "${name}"` })
      }
      resetForm()
      mutate()
    } catch (e: any) {
      setFormError(e?.message?.replace(/^API \d+: /, '') || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleEdit = (org: any) => {
    setEditId(org.id)
    setName(org.name)
    setDesc(org.description || '')
    // Pre-select the current owner so an admin save without changes
    // doesn't accidentally reassign ownership.
    setOwnerId(org.user_id && me && org.user_id !== me.id ? org.user_id : '')
    setFormError('')
    setShowForm(true)
  }

  const handleDelete = async (id: string, orgName: string) => {
    const ok = await confirm({
      title: 'Delete organization',
      message: `Delete organization "${orgName}"?`,
      variant: 'danger',
      confirmLabel: 'Delete',
    })
    if (!ok) return
    try {
      await deleteOrganization(id)
      mutate()
      toast({ kind: 'success', message: `Deleted organization "${orgName}"` })
    } catch (e: any) {
      toast({ kind: 'error', message: e?.message?.replace(/^API \d+: /, '') || 'Delete failed' })
    }
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
            {isAdmin && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Owner</span>
                <select
                  className="input"
                  value={ownerId}
                  onChange={(e) => setOwnerId(e.target.value)}
                >
                  <option value="">
                    {me ? `Assign to me — ${me.name} (${me.email})` : 'Assign to me (admin)'}
                  </option>
                  {users
                    .filter((u) => !me || u.id !== me.id)
                    .map((u) => (
                      <option key={u.id} value={u.id} disabled={!u.is_active}>
                        {u.name} ({u.email}){!u.is_active ? ' — inactive' : ''}
                      </option>
                    ))}
                </select>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  Leave on “Assign to me” to keep ownership with the current admin.
                </span>
              </label>
            )}
            {formError && (
              <div style={{ color: 'var(--color-danger, #c53030)', fontSize: '0.85rem' }}>{formError}</div>
            )}
            <button className="btn btn-primary" onClick={handleSubmit} disabled={saving} style={{ alignSelf: 'flex-start' }}>
              {saving ? 'Saving…' : editId ? 'Save' : 'Create'}
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
              <div>Owner: {ownerLabel(org.user_id)}</div>
              <div>Created: {formatLocalDate(org.created_at)}</div>
            </div>
          </div>
        ))}
      </div>
    </DashboardLayout>
  )
}
