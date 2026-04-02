'use client'

import { Suspense, useState, useRef, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { verifyOtp, resendOtp } from '@/lib/auth'
import styles from '../login/page.module.css'
import verifyStyles from './page.module.css'

const OTP_LENGTH = 6
const COOLDOWN_SECONDS = 120

function VerifyForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const email = searchParams.get('email') || ''

  const [otp, setOtp] = useState<string[]>(Array(OTP_LENGTH).fill(''))
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(false)
  const [cooldown, setCooldown] = useState(COOLDOWN_SECONDS)
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  // Redirect if no email
  useEffect(() => {
    if (!email) router.push('/register')
  }, [email, router])

  // Cooldown timer
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setInterval(() => setCooldown((c) => c - 1), 1000)
    return () => clearInterval(timer)
  }, [cooldown])

  const handleChange = useCallback((index: number, value: string) => {
    if (!/^\d*$/.test(value)) return
    const digit = value.slice(-1)
    setOtp((prev) => {
      const next = [...prev]
      next[index] = digit
      return next
    })
    if (digit && index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus()
    }
  }, [])

  const handleKeyDown = useCallback((index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
    }
  }, [otp])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH)
    if (!pasted) return
    const digits = pasted.split('')
    setOtp((prev) => {
      const next = [...prev]
      digits.forEach((d, i) => { next[i] = d })
      return next
    })
    const focusIdx = Math.min(digits.length, OTP_LENGTH - 1)
    inputRefs.current[focusIdx]?.focus()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const code = otp.join('')
    if (code.length !== OTP_LENGTH) {
      setError('Please enter the full 6-digit code')
      return
    }
    setError('')
    setLoading(true)
    const result = await verifyOtp(email, code)
    setLoading(false)

    if (!result.ok) {
      setError(result.error || 'Verification failed')
      return
    }

    setSuccess('Email verified! Redirecting to login…')
    setTimeout(() => router.push('/login'), 1500)
  }

  const handleResend = async () => {
    if (cooldown > 0) return
    setError('')
    const result = await resendOtp(email)
    if (!result.ok) {
      if (result.cooldownSeconds) {
        setCooldown(result.cooldownSeconds)
      }
      setError(result.error || 'Failed to resend code')
      return
    }
    setCooldown(COOLDOWN_SECONDS)
    setSuccess('New verification code sent!')
    setTimeout(() => setSuccess(''), 3000)
  }

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  if (!email) return null

  return (
    <div className={styles.card}>
      <div className={styles.logo}>
        <span className={styles.logoIcon}>🌽</span>
        <span className={styles.logoText}>Corn Hub</span>
      </div>

      <h1 className={styles.heading}>Verify your email</h1>
      <p className={styles.sub}>
        We sent a 6-digit code to <strong>{email}</strong>
      </p>

      <form className={styles.form} onSubmit={handleSubmit}>
        {error && <div className={styles.error}>{error}</div>}
        {success && <div className={verifyStyles.success}>{success}</div>}

        <div className={verifyStyles.otpContainer} onPaste={handlePaste}>
          {Array.from({ length: OTP_LENGTH }).map((_, i) => (
            <input
              key={i}
              ref={(el) => { inputRefs.current[i] = el }}
              className={verifyStyles.otpInput}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={otp[i]}
              onChange={(e) => handleChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              autoFocus={i === 0}
              autoComplete="one-time-code"
            />
          ))}
        </div>

        <button className={styles.btn} type="submit" disabled={loading}>
          {loading ? <span className={styles.spinner} /> : null}
          {loading ? 'Verifying…' : 'Verify Email'}
        </button>
      </form>

      <div className={verifyStyles.resendRow}>
        {cooldown > 0 ? (
          <span className={verifyStyles.cooldownText}>
            Resend code in {formatTime(cooldown)}
          </span>
        ) : (
          <button className={verifyStyles.resendBtn} onClick={handleResend}>
            Resend verification code
          </button>
        )}
      </div>

      <div className={styles.footer}>
        <Link href="/login">← Back to login</Link>
      </div>
    </div>
  )
}

export default function VerifyPage() {
  return (
    <div className={styles.page}>
      <Suspense>
        <VerifyForm />
      </Suspense>
    </div>
  )
}
