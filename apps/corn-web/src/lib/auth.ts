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
): Promise<{ ok: boolean; user?: AuthUser; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      credentials: 'include',
    })
    const data = await res.json()
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
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
      credentials: 'include',
    })
    const data = await res.json()
    if (!res.ok) return { ok: false, error: data.error || 'Registration failed' }
    return { ok: true }
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
