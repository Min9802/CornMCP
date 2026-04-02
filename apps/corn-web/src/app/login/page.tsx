'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { login } from '@/lib/auth'
import styles from './page.module.css'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Show error from Google OAuth redirect
  const oauthError = searchParams.get('error')
  const oauthErrorMsg: Record<string, string> = {
    google_cancelled: 'Google sign-in was cancelled.',
    google_token_failed: 'Failed to exchange Google token. Please try again.',
    google_userinfo_failed: 'Failed to get Google account info.',
    google_email_unverified: 'Your Google account email is not verified.',
    google_not_configured: 'Google sign-in is not configured.',
    google_internal_error: 'An error occurred during Google sign-in.',
    account_disabled: 'Your account has been disabled.',
  }

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

  const handleGoogleLogin = () => {
    window.location.href = `${API_BASE}/api/auth/google`
  }

  return (
    <div className={styles.card}>
      <div className={styles.logo}>
        <span className={styles.logoIcon}>🌽</span>
        <span className={styles.logoText}>Corn Hub</span>
      </div>

      <h1 className={styles.heading}>Welcome back</h1>
      <p className={styles.sub}>Sign in to your AI intelligence platform</p>

      {(oauthError || error) && (
        <div className={styles.error}>{oauthErrorMsg[oauthError || ''] || error}</div>
      )}

      {/* Google Login Button */}
      <button className={styles.googleBtn} type="button" onClick={handleGoogleLogin}>
        <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
          <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
          <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" fill="#34A853"/>
          <path d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.347 6.175 0 7.55 0 9s.348 2.825.957 4.039l3.007-2.332z" fill="#FBBC05"/>
          <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z" fill="#EA4335"/>
        </svg>
        Continue with Google
      </button>

      <div className={styles.divider}><span>or</span></div>

      <form className={styles.form} onSubmit={handleSubmit}>
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
