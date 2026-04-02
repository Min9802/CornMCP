'use client'

import { Suspense, useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import styles from './page.module.css'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'

function SetPasswordForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const isNewGoogle = searchParams.get('new_google') === '1'

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [show, setShow] = useState(false)

  useEffect(() => {
    // Animate in
    const t = setTimeout(() => setShow(true), 50)
    return () => clearTimeout(t)
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }
    setError('')
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/auth/set-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        credentials: 'include',
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Failed to set password')
        return
      }
      router.push('/')
      router.refresh()
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.overlay}>
      <div className={`${styles.modal} ${show ? styles.modalVisible : ''}`}>
        {/* Icon */}
        <div className={styles.iconWrap}>
          <span className={styles.icon}>🔐</span>
        </div>

        <h2 className={styles.title}>
          {isNewGoogle ? 'Welcome! Set Your Password' : 'Set a Password'}
        </h2>
        <p className={styles.subtitle}>
          {isNewGoogle
            ? 'Your account was created via Google. Set a password so you can also sign in with email.'
            : 'Create a password for your account.'}
        </p>

        <form className={styles.form} onSubmit={handleSubmit}>
          {error && <div className={styles.error}>{error}</div>}

          <div className={styles.field}>
            <label className={styles.label}>New Password</label>
            <input
              className={styles.input}
              type="password"
              placeholder="Min 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Confirm Password</label>
            <input
              className={styles.input}
              type="password"
              placeholder="Repeat password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>

          {/* Password strength bar */}
          <div className={styles.strengthBar}>
            <div
              className={styles.strengthFill}
              style={{
                width: password.length === 0 ? '0%'
                  : password.length < 8 ? '25%'
                  : password.length < 12 ? '60%'
                  : '100%',
                background: password.length === 0 ? 'transparent'
                  : password.length < 8 ? '#ef4444'
                  : password.length < 12 ? '#f59e0b'
                  : '#22c55e',
              }}
            />
          </div>

          <div className={styles.actions}>
            <button className={styles.btnPrimary} type="submit" disabled={loading}>
              {loading ? <span className={styles.spinner} /> : null}
              {loading ? 'Saving…' : 'Save Password'}
            </button>
            {!isNewGoogle && (
              <button
                className={styles.btnSkip}
                type="button"
                onClick={() => router.push('/')}
              >
                Skip for now
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}

export default function SetPasswordPage() {
  return (
    <Suspense>
      <SetPasswordForm />
    </Suspense>
  )
}
