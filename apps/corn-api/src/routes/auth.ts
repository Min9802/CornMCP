import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { dbGet, dbRun, dbAll } from '../db/client.js'
import { generateId, hashApiKey } from '@corn/shared-utils'
import { signJwt, verifyJwt, getCookie, setCookie, deleteCookie, type AuthUser } from '../middleware/auth.js'
import { sendOtpEmail } from '../services/mailer.js'

export const authRouter = new Hono()

// ── Helper: generate & store OTP ─────────────────────────
async function generateAndSendOtp(userId: string, email: string): Promise<boolean> {
  const otp = crypto.randomInt(100000, 999999).toString()
  const otpHash = await bcrypt.hash(otp, 10)
  const id = generateId('otp')
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  // Delete old OTPs for this user
  await dbRun('DELETE FROM email_otps WHERE user_id = ?', [userId])

  await dbRun(
    'INSERT INTO email_otps (id, user_id, otp_hash, expires_at) VALUES (?, ?, ?, ?)',
    [id, userId, otpHash, expiresAt],
  )

  return sendOtpEmail(email, otp)
}

// ─── Register ────────────────────────────────────────────
// First user → auto admin + auto verified. Others → OTP verification required.
authRouter.post('/register', async (c) => {
  const body = await c.req.json()
  const { email, password, name } = body

  if (!email || !password || !name) {
    return c.json({ error: 'email, password and name are required' }, 400)
  }
  if (password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400)
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'Invalid email format' }, 400)
  }

  const userCount = await dbGet('SELECT COUNT(*) as count FROM users')
  const isFirst = Number(userCount?.['count'] ?? 0) === 0

  const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email.toLowerCase()])
  if (existing) return c.json({ error: 'Email already registered' }, 409)

  const id = generateId('usr')
  const passwordHash = await bcrypt.hash(password, 12)
  const role = isFirst ? 'admin' : 'user'
  const emailVerified = isFirst ? 1 : 0

  await dbRun(
    `INSERT INTO users (id, email, password_hash, name, role, is_active, email_verified)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
    [id, email.toLowerCase(), passwordHash, name, role, emailVerified],
  )

  // First user (admin) → auto verified, no OTP
  if (isFirst) {
    return c.json({ ok: true, id, role }, 201)
  }

  // Send OTP email
  await generateAndSendOtp(id, email.toLowerCase())

  return c.json({ ok: true, id, role, needsVerification: true }, 201)
})

// ─── Login ───────────────────────────────────────────────
authRouter.post('/login', async (c) => {
  const body = await c.req.json()
  const { email, password } = body

  if (!email || !password) return c.json({ error: 'email and password are required' }, 400)

  const row = await dbGet(
    'SELECT id, email, name, role, password_hash, email_verified FROM users WHERE email = ? AND is_active = 1',
    [email.toLowerCase()],
  )
  if (!row) return c.json({ error: 'Invalid email or password' }, 401)

  const valid = await bcrypt.compare(password, row['password_hash'] as string)
  if (!valid) return c.json({ error: 'Invalid email or password' }, 401)

  // Check email verification
  if (!row['email_verified']) {
    await generateAndSendOtp(row['id'] as string, email.toLowerCase())
    return c.json({ ok: false, needsVerification: true, email: email.toLowerCase() }, 403)
  }

  const user: AuthUser = {
    id: row['id'] as string,
    email: row['email'] as string,
    name: row['name'] as string,
    role: row['role'] as 'admin' | 'user',
  }

  const token = await signJwt(user)

  setCookie(c, 'corn_token', token, {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'Lax',
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
  })

  return c.json({ ok: true, user })
})

// ─── Verify OTP ──────────────────────────────────────────
authRouter.post('/verify-otp', async (c) => {
  const body = await c.req.json()
  const { email, otp } = body

  if (!email || !otp) return c.json({ error: 'email and otp are required' }, 400)

  const user = await dbGet('SELECT id FROM users WHERE email = ? AND is_active = 1', [email.toLowerCase()])
  if (!user) return c.json({ error: 'User not found' }, 404)

  const userId = user['id'] as string
  const otpRow = await dbGet(
    'SELECT id, otp_hash, expires_at FROM email_otps WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
    [userId],
  )

  if (!otpRow) return c.json({ error: 'No verification code found. Please request a new one.' }, 400)

  // Check expiry
  const expiresAt = new Date(otpRow['expires_at'] as string).getTime()
  if (Date.now() > expiresAt) {
    await dbRun('DELETE FROM email_otps WHERE user_id = ?', [userId])
    return c.json({ error: 'Verification code expired. Please request a new one.' }, 400)
  }

  // Check OTP
  const match = await bcrypt.compare(otp, otpRow['otp_hash'] as string)
  if (!match) return c.json({ error: 'Invalid verification code' }, 400)

  // Mark verified & cleanup
  await dbRun('UPDATE users SET email_verified = 1, updated_at = datetime(\'now\') WHERE id = ?', [userId])
  await dbRun('DELETE FROM email_otps WHERE user_id = ?', [userId])

  return c.json({ ok: true })
})

// ─── Resend OTP ──────────────────────────────────────────
authRouter.post('/resend-otp', async (c) => {
  const body = await c.req.json()
  const { email } = body

  if (!email) return c.json({ error: 'email is required' }, 400)

  const user = await dbGet(
    'SELECT id, email_verified FROM users WHERE email = ? AND is_active = 1',
    [email.toLowerCase()],
  )
  if (!user) return c.json({ error: 'User not found' }, 404)
  if (user['email_verified']) return c.json({ error: 'Email already verified' }, 400)

  const userId = user['id'] as string

  // Check cooldown — 2 minutes
  const lastOtp = await dbGet(
    'SELECT created_at FROM email_otps WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
    [userId],
  )
  if (lastOtp) {
    const createdAt = new Date(lastOtp['created_at'] as string).getTime()
    const cooldownMs = 2 * 60 * 1000
    const elapsed = Date.now() - createdAt
    if (elapsed < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - elapsed) / 1000)
      return c.json({ error: `Please wait ${remaining} seconds before requesting a new code`, cooldownSeconds: remaining }, 429)
    }
  }

  await generateAndSendOtp(userId, email.toLowerCase())

  return c.json({ ok: true })
})

// ─── Logout ──────────────────────────────────────────────
authRouter.post('/logout', (c) => {
  deleteCookie(c, 'corn_token', { path: '/' })
  return c.json({ ok: true })
})

// ─── Me ──────────────────────────────────────────────────
authRouter.get('/me', async (c) => {
  const token = getCookie(c, 'corn_token')
  if (!token) return c.json({ error: 'Not authenticated' }, 401)
  const user = await verifyJwt(token)
  if (!user) return c.json({ error: 'Invalid session' }, 401)
  return c.json({ user })
})

// ─── Validate API Key (for MCP server) ───────────────────
// MCP server calls this to validate user API keys against the DB.
authRouter.post('/validate-key', async (c) => {
  const body = await c.req.json()
  const rawKey = body.key
  if (!rawKey) return c.json({ valid: false, error: 'No key provided' }, 400)

  const keyHash = hashApiKey(rawKey)
  const keyRow = await dbGet(
    'SELECT k.id, k.name, k.user_id, u.email, u.name as user_name, u.role FROM api_keys k LEFT JOIN users u ON k.user_id = u.id WHERE k.key_hash = ?',
    [keyHash],
  )
  if (!keyRow) return c.json({ valid: false, error: 'Invalid API key' })

  // Update last_used_at
  await dbRun(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`, [keyRow['id'] as string])

  return c.json({
    valid: true,
    keyId: keyRow['id'],
    keyName: keyRow['name'],
    userId: keyRow['user_id'],
    userName: keyRow['user_name'],
    userRole: keyRow['role'],
  })
})

// ─── Google OAuth ─────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env['GOOGLE_CLIENT_ID'] || ''
const GOOGLE_CLIENT_SECRET = process.env['GOOGLE_CLIENT_SECRET'] || ''

function getGoogleRedirectUri(c: { req: { url: string } }): string {
  const url = new URL(c.req.url)
  return `${url.protocol}//${url.host}/api/auth/google/callback`
}

// Step 1: Redirect to Google consent screen
authRouter.get('/google', (c) => {
  if (!GOOGLE_CLIENT_ID) return c.json({ error: 'Google OAuth not configured' }, 503)

  const redirectUri = getGoogleRedirectUri(c)
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
  })

  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`)
})

// Step 2: Google callback — exchange code → token → user info → login/register
authRouter.get('/google/callback', async (c) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return c.redirect('/login?error=google_not_configured')
  }

  const code = c.req.query('code')
  const error = c.req.query('error')

  if (error || !code) {
    return c.redirect(`/login?error=${encodeURIComponent(error || 'google_cancelled')}`)
  }

  const redirectUri = getGoogleRedirectUri(c)
  const webOrigin = process.env['CORS_ORIGIN'] || 'http://localhost:3000'

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    })

    if (!tokenRes.ok) {
      return c.redirect(`${webOrigin}/login?error=google_token_failed`)
    }

    const tokenData = await tokenRes.json() as { access_token: string }
    const accessToken = tokenData.access_token

    // Get user info from Google
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (!userInfoRes.ok) {
      return c.redirect(`${webOrigin}/login?error=google_userinfo_failed`)
    }

    const googleUser = await userInfoRes.json() as {
      id: string
      email: string
      name: string
      picture?: string
      verified_email: boolean
    }

    if (!googleUser.email || !googleUser.verified_email) {
      return c.redirect(`${webOrigin}/login?error=google_email_unverified`)
    }

    const email = googleUser.email.toLowerCase()

    // Find existing user by google_id or email
    let user = await dbGet(
      'SELECT id, email, name, role, is_active, google_id FROM users WHERE google_id = ? OR email = ?',
      [googleUser.id, email],
    )

    if (user) {
      // Existing user — update google_id/avatar if not set
      if (!user['is_active']) {
        return c.redirect(`${webOrigin}/login?error=account_disabled`)
      }
      await dbRun(
        `UPDATE users SET google_id = ?, avatar_url = ?, email_verified = 1, updated_at = datetime('now') WHERE id = ?`,
        [googleUser.id, googleUser.picture || null, user['id']],
      )
    } else {
      // New user via Google — always 'user' role
      const userCount = await dbGet('SELECT COUNT(*) as count FROM users')
      // Only auto-admin if truly the first user ever
      const isFirst = Number(userCount?.['count'] ?? 0) === 0
      const id = generateId('usr')
      await dbRun(
        `INSERT INTO users (id, email, password_hash, name, role, is_active, email_verified, google_id, avatar_url)
         VALUES (?, ?, NULL, ?, ?, 1, 1, ?, ?)`,
        [id, email, googleUser.name, isFirst ? 'admin' : 'user', googleUser.id, googleUser.picture || null],
      )
      user = await dbGet('SELECT id, email, name, role FROM users WHERE id = ?', [id])
    }

    const authUser: AuthUser = {
      id: user!['id'] as string,
      email: user!['email'] as string,
      name: user!['name'] as string,
      role: user!['role'] as 'admin' | 'user',
    }

    const token = await signJwt(authUser)
    setCookie(c, 'corn_token', token, {
      httpOnly: true,
      secure: process.env['NODE_ENV'] === 'production',
      sameSite: 'Lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    })

    return c.redirect(webOrigin)
  } catch (err) {
    console.error('[Google OAuth] error:', err)
    return c.redirect(`${webOrigin}/login?error=google_internal_error`)
  }
})
