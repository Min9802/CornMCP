'use client'

import { useState } from 'react'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { getUsers, createUser, updateUser, deleteUser, type UserRecord } from '@/lib/api'
import { getMe, type AuthUser } from '@/lib/auth'

function initials(name: string) {
  return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
}

function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const colors = ['#fbbf24', '#3b82f6', '#22c55e', '#a855f7', '#ef4444', '#14b8a6']
  const color = colors[name.charCodeAt(0) % colors.length]
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: `${color}22`, border: `2px solid ${color}44`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.38, fontWeight: 700, color, flexShrink: 0,
    }}>
      {initials(name)}
    </div>
  )
}

interface UserFormState {
  name: string
  email: string
  password: string
  role: 'admin' | 'user'
}

const emptyForm: UserFormState = { name: '', email: '', password: '', role: 'user' }

export default function UsersPage() {
  const { data, mutate, isLoading } = useSWR('users', getUsers)
  const { data: me } = useSWR('me', getMe)

  const [showModal, setShowModal] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState<UserFormState>(emptyForm)
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  const openCreate = () => { setForm(emptyForm); setEditId(null); setFormError(''); setShowModal(true) }
  const openEdit = (u: UserRecord) => {
    setForm({ name: u.name, email: u.email, password: '', role: u.role })
    setEditId(u.id)
    setFormError('')
    setShowModal(true)
  }
  const closeModal = () => { setShowModal(false); setEditId(null); setForm(emptyForm); setFormError('') }

  const handleSave = async () => {
    if (!form.name || (!editId && (!form.email || !form.password))) {
      setFormError('Please fill all required fields')
      return
    }
    setSaving(true)
    setFormError('')
    try {
      if (editId) {
        const payload: any = { name: form.name, role: form.role }
        if (form.password) payload.password = form.password
        await updateUser(editId, payload)
      } else {
        await createUser(form)
      }
      await mutate()
      closeModal()
    } catch (e: any) {
      setFormError(e.message?.replace(/^API \d+: /, '') || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleToggleActive = async (u: UserRecord) => {
    if (u.id === me?.id) return
    try {
      await updateUser(u.id, { isActive: !u.is_active })
      mutate()
    } catch { /* ignore */ }
  }

  const handleDelete = async (u: UserRecord) => {
    if (u.id === me?.id) return
    if (!confirm(`Delete user "${u.name}"? This cannot be undone.`)) return
    try {
      await deleteUser(u.id)
      mutate()
    } catch (e: any) {
      alert(e.message?.replace(/^API \d+: /, '') || 'Delete failed')
    }
  }

  const users = data?.users || []

  return (
    <DashboardLayout title="Users" subtitle="Manage user accounts and permissions">
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--space-4)' }}>
        <button className="btn btn-primary" onClick={openCreate}>+ Add User</button>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {isLoading ? (
          <div style={{ padding: 'var(--space-10)', textAlign: 'center', color: 'var(--text-muted)' }}>
            Loading users…
          </div>
        ) : users.length === 0 ? (
          <div style={{ padding: 'var(--space-10)', textAlign: 'center', color: 'var(--text-muted)' }}>
            No users found
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
                {['User', 'Email', 'Role', 'Status', 'Created', 'Actions'].map((h) => (
                  <th key={h} style={{
                    padding: 'var(--space-4) var(--space-5)',
                    textAlign: 'left', fontWeight: 600, fontSize: '0.8rem',
                    color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u, i) => (
                <tr key={u.id} style={{
                  borderBottom: i < users.length - 1 ? '1px solid var(--border)' : 'none',
                  transition: 'background 0.15s',
                }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-card-hover)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                >
                  <td style={{ padding: 'var(--space-4) var(--space-5)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                      <Avatar name={u.name} />
                      <div>
                        <div style={{ fontWeight: 600 }}>{u.name}</div>
                        {u.id === me?.id && (
                          <div style={{ fontSize: '0.72rem', color: 'var(--corn-gold)', marginTop: 2 }}>You</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: 'var(--space-4) var(--space-5)', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                    {u.email}
                  </td>
                  <td style={{ padding: 'var(--space-4) var(--space-5)' }}>
                    <span className={`badge ${u.role === 'admin' ? 'badge-warning' : 'badge-info'}`}>
                      {u.role === 'admin' ? '👑 Admin' : '👤 User'}
                    </span>
                  </td>
                  <td style={{ padding: 'var(--space-4) var(--space-5)' }}>
                    <span className={`badge ${u.is_active ? 'badge-healthy' : 'badge-error'}`}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td style={{ padding: 'var(--space-4) var(--space-5)', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                    {new Date(u.created_at).toLocaleDateString()}
                  </td>
                  <td style={{ padding: 'var(--space-4) var(--space-5)' }}>
                    <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => openEdit(u)}>Edit</button>
                      {u.id !== me?.id && (
                        <>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleToggleActive(u)}
                            style={{ color: u.is_active ? 'var(--corn-gold)' : 'var(--corn-green)' }}
                          >
                            {u.is_active ? 'Deactivate' : 'Activate'}
                          </button>
                          <button className="btn btn-danger btn-sm" onClick={() => handleDelete(u)}>Delete</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Modal */}
      {showModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-4)',
        }}>
          <div className="card animate-in" style={{ width: '100%', maxWidth: 440, maxHeight: '90vh', overflowY: 'auto' }}>
            <h3 style={{ fontWeight: 700, marginBottom: 'var(--space-6)', fontSize: '1.1rem' }}>
              {editId ? 'Edit User' : 'New User'}
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              {formError && (
                <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--corn-red)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', fontSize: '0.85rem' }}>
                  {formError}
                </div>
              )}

              <div>
                <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Full Name *</label>
                <input className="input" placeholder="John Doe" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>

              {!editId && (
                <div>
                  <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Email *</label>
                  <input className="input" type="email" placeholder="user@example.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </div>
              )}

              <div>
                <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
                  {editId ? 'New Password (leave blank to keep)' : 'Password *'}
                </label>
                <input className="input" type="password" placeholder="Min. 8 characters" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </div>

              <div>
                <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Role</label>
                <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'admin' | 'user' })}>
                  <option value="user">👤 User</option>
                  <option value="admin">👑 Admin</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-6)', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={closeModal}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  )
}
