const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'

export interface AuthUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'user'
}

export async function login(
  email: string,
  password: string,
): Promise<{ ok: boolean; user?: AuthUser; error?: string; needsVerification?: boolean; email?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      credentials: 'include',
    })
    const data = await res.json()
    if (res.status === 403 && data.needsVerification) {
      return { ok: false, needsVerification: true, email: data.email }
    }
    if (!res.ok) return { ok: false, error: data.error || 'Login failed' }
    return { ok: true, user: data.user }
  } catch {
    return { ok: false, error: 'Network error — is the API running?' }
  }
}

export async function register(
  email: string,
  password: string,
  name: string,
): Promise<{ ok: boolean; error?: string; needsVerification?: boolean }> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
      credentials: 'include',
    })
    const data = await res.json()
    if (!res.ok) return { ok: false, error: data.error || 'Registration failed' }
    return { ok: true, needsVerification: data.needsVerification }
  } catch {
    return { ok: false, error: 'Network error — is the API running?' }
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', credentials: 'include' })
  } catch { /* ignore */ }
  // Clear cookie client-side as fallback
  document.cookie = 'corn_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
  window.location.href = '/login'
}

export async function verifyOtp(
  email: string,
  otp: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, otp }),
      credentials: 'include',
    })
    const data = await res.json()
    if (!res.ok) return { ok: false, error: data.error || 'Verification failed' }
    return { ok: true }
  } catch {
    return { ok: false, error: 'Network error — is the API running?' }
  }
}

export async function resendOtp(
  email: string,
): Promise<{ ok: boolean; error?: string; cooldownSeconds?: number }> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/resend-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      credentials: 'include',
    })
    const data = await res.json()
    if (!res.ok) return { ok: false, error: data.error, cooldownSeconds: data.cooldownSeconds }
    return { ok: true }
  } catch {
    return { ok: false, error: 'Network error — is the API running?' }
  }
}

export async function getMe(): Promise<AuthUser | null> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, { credentials: 'include' })
    if (!res.ok) return null
    const data = await res.json()
    return data.user
  } catch {
    return null
  }
}
