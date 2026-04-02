'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { login } from '@/lib/auth'
import styles from './page.module.css'

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email || !password) {
      setError('Please enter email and password')
      return
    }
    setError('')
    setLoading(true)
    const result = await login(email, password)
    setLoading(false)

    if (!result.ok) {
      if (result.needsVerification) {
        router.push(`/verify?email=${encodeURIComponent(result.email || email)}`)
        return
      }
      setError(result.error || 'Login failed')
      return
    }

    const from = searchParams.get('from') || '/'
    router.push(from)
    router.refresh()
  }

  return (
    <div className={styles.card}>
      <div className={styles.logo}>
        <span className={styles.logoIcon}>🌽</span>
        <span className={styles.logoText}>Corn Hub</span>
      </div>

      <h1 className={styles.heading}>Welcome back</h1>
      <p className={styles.sub}>Sign in to your AI intelligence platform</p>

      <form className={styles.form} onSubmit={handleSubmit}>
        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.field}>
          <label className={styles.label}>Email</label>
          <input
            className={styles.input}
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoFocus
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Password</label>
          <input
            className={styles.input}
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>

        <button className={styles.btn} type="submit" disabled={loading}>
          {loading ? <span className={styles.spinner} /> : null}
          {loading ? 'Signing in…' : 'Sign In'}
        </button>
      </form>

      <div className={styles.footer}>
        Don't have an account?{' '}
        <Link href="/register">Create account</Link>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <div className={styles.page}>
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  )
}
