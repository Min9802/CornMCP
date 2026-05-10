import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { generateId, hashApiKey } from '@corn/shared-utils'
import { ApiKey, EmailOtp, User } from '../db/mongoose/index.js'
import { signJwt, verifyJwt, getCookie, setCookie, deleteCookie, type AuthUser } from '../middleware/auth.js'
import { sendOtpEmail } from '../services/mailer.js'

export const authRouter = new Hono()

// ── Helper: generate & store OTP ─────────────────────
async function generateAndSendOtp(userId: string, email: string): Promise<boolean> {
  const otp = crypto.randomInt(100000, 999999).toString()
  const otpHash = await bcrypt.hash(otp, 10)
  const id = generateId('otp')
  // expires_at is a Date so the schema TTL index (expireAfterSeconds: 0)
  // can clean up expired rows automatically.
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

  // Replace any in-flight OTP for this user; only one valid code at a time.
  await EmailOtp.deleteMany({ user_id: userId })
  await EmailOtp.create({
    _id: id,
    user_id: userId,
    otp_hash: otpHash,
    expires_at: expiresAt,
  })

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

  const lowercased = (email as string).toLowerCase()
  const [userCount, existing] = await Promise.all([
    User.countDocuments(),
    User.findOne({ email: lowercased }, { _id: 1 }).lean(),
  ])
  const isFirst = userCount === 0
  if (existing) return c.json({ error: 'Email already registered' }, 409)

  const id = generateId('usr')
  const passwordHash = await bcrypt.hash(password, 12)
  const role: 'admin' | 'user' = isFirst ? 'admin' : 'user'

  // Cast payload — Mongoose 9 strict types don't accept null/boolean
  // defaults at the call site even though the schema validates them
  // at runtime. See https://github.com/Automattic/mongoose/issues/14013.
  await User.create({
    _id: id,
    email: lowercased,
    password_hash: passwordHash,
    name,
    role,
    email_verified: isFirst,
  } as Parameters<typeof User.create>[0])

  // First user (admin) → auto verified, no OTP
  if (isFirst) {
    return c.json({ ok: true, id, role }, 201)
  }

  // Send OTP email
  await generateAndSendOtp(id, lowercased)

  return c.json({ ok: true, id, role, needsVerification: true }, 201)
})

// ─── Login ───────────────────────────────────────────────
authRouter.post('/login', async (c) => {
  const body = await c.req.json()
  const { email, password } = body

  if (!email || !password) return c.json({ error: 'email and password are required' }, 400)

  const lowercased = (email as string).toLowerCase()
  const row = await User.findOne(
    { email: lowercased, is_active: true },
    { _id: 1, email: 1, name: 1, role: 1, password_hash: 1, email_verified: 1 },
  ).lean()
  if (!row) return c.json({ error: 'Invalid email or password' }, 401)

  // password_hash can be null for OAuth-only accounts — reject password
  // logins for those.
  if (!row.password_hash) return c.json({ error: 'Invalid email or password' }, 401)
  const valid = await bcrypt.compare(password, row.password_hash)
  if (!valid) return c.json({ error: 'Invalid email or password' }, 401)

  // Check email verification
  if (!row.email_verified) {
    await generateAndSendOtp(row._id, lowercased)
    return c.json({ ok: false, needsVerification: true, email: lowercased }, 403)
  }

  const user: AuthUser = {
    id: row._id,
    email: row.email,
    name: row.name,
    role: row.role,
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

// ─── Verify OTP ─────────────────────────────────────────
authRouter.post('/verify-otp', async (c) => {
  const body = await c.req.json()
  const { email, otp } = body

  if (!email || !otp) return c.json({ error: 'email and otp are required' }, 400)

  const lowercased = (email as string).toLowerCase()
  const user = await User.findOne({ email: lowercased, is_active: true }, { _id: 1 }).lean()
  if (!user) return c.json({ error: 'User not found' }, 404)

  const userId = user._id
  // Latest OTP for this user (we only ever keep one valid row, but tolerate
  // legacy rows that pre-date the dedup logic by sorting).
  const otpRow = await EmailOtp.findOne(
    { user_id: userId },
    { _id: 1, otp_hash: 1, expires_at: 1 },
  )
    .sort({ created_at: -1 })
    .lean()

  if (!otpRow) return c.json({ error: 'No verification code found. Please request a new one.' }, 400)

  // Check expiry
  if (Date.now() > otpRow.expires_at.getTime()) {
    await EmailOtp.deleteMany({ user_id: userId })
    return c.json({ error: 'Verification code expired. Please request a new one.' }, 400)
  }

  // Check OTP
  const match = await bcrypt.compare(otp, otpRow.otp_hash)
  if (!match) return c.json({ error: 'Invalid verification code' }, 400)

  // Mark verified & cleanup. updated_at is auto-managed by `timestamps`.
  await Promise.all([
    User.updateOne({ _id: userId }, { $set: { email_verified: true } }),
    EmailOtp.deleteMany({ user_id: userId }),
  ])

  return c.json({ ok: true })
})

// ─── Resend OTP ─────────────────────────────────────────
authRouter.post('/resend-otp', async (c) => {
  const body = await c.req.json()
  const { email } = body

  if (!email) return c.json({ error: 'email is required' }, 400)

  const lowercased = (email as string).toLowerCase()
  const user = await User.findOne(
    { email: lowercased, is_active: true },
    { _id: 1, email_verified: 1 },
  ).lean()
  if (!user) return c.json({ error: 'User not found' }, 404)
  if (user.email_verified) return c.json({ error: 'Email already verified' }, 400)

  const userId = user._id

  // Check cooldown — 2 minutes between OTP requests.
  const lastOtp = await EmailOtp.findOne({ user_id: userId }, { created_at: 1 })
    .sort({ created_at: -1 })
    .lean()
  if (lastOtp?.created_at) {
    const cooldownMs = 2 * 60 * 1000
    const elapsed = Date.now() - lastOtp.created_at.getTime()
    if (elapsed < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - elapsed) / 1000)
      return c.json({ error: `Please wait ${remaining} seconds before requesting a new code`, cooldownSeconds: remaining }, 429)
    }
  }

  await generateAndSendOtp(userId, lowercased)

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

// ─── Validate API Key (for MCP server) ───────────────
// MCP server calls this to validate user API keys against the DB. The
// SQL version did a LEFT JOIN on users; we issue two queries here
// because Mongo doesn't have FK joins. Same result shape.
authRouter.post('/validate-key', async (c) => {
  const body = await c.req.json()
  const rawKey = body.key
  if (!rawKey) return c.json({ valid: false, error: 'No key provided' }, 400)

  const keyHash = hashApiKey(rawKey)
  const keyRow = await ApiKey.findOne(
    { key_hash: keyHash },
    { _id: 1, name: 1, user_id: 1 },
  ).lean()
  if (!keyRow) return c.json({ valid: false, error: 'Invalid API key' })

  // user_id is nullable on legacy keys created before tenancy.
  const userRow = keyRow.user_id
    ? await User.findById(keyRow.user_id, { email: 1, name: 1, role: 1 }).lean()
    : null

  // Update last_used_at — fire and forget to keep MCP latency low.
  void ApiKey.updateOne({ _id: keyRow._id }, { $set: { last_used_at: new Date() } })

  return c.json({
    valid: true,
    keyId: keyRow._id,
    keyName: keyRow.name,
    userId: keyRow.user_id,
    userName: userRow?.name ?? null,
    userRole: userRow?.role ?? null,
  })
})

// ─── Google OAuth ─────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env['GOOGLE_CLIENT_ID'] || ''
const GOOGLE_CLIENT_SECRET = process.env['GOOGLE_CLIENT_SECRET'] || ''

function getGoogleRedirectUri(c: { req: { url: string; header: (name: string) => string | undefined } }): string {
  const url = new URL(c.req.url)
  // Behind nginx reverse proxy, use X-Forwarded-Proto to get the real scheme
  const proto = c.req.header('x-forwarded-proto') || url.protocol.replace(':', '')
  const host = c.req.header('x-forwarded-host') || url.host
  return `${proto}://${host}/api/auth/google/callback`
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

    const emailLower = googleUser.email.toLowerCase()

    // Find existing user by google_id or email. SQL version used `OR`
    // in a single query; Mongo equivalent is `$or`.
    let user = await User.findOne(
      { $or: [{ google_id: googleUser.id }, { email: emailLower }] },
      { _id: 1, email: 1, name: 1, role: 1, is_active: 1, google_id: 1 },
    ).lean()
    let isNewUser = false

    if (user) {
      if (!user.is_active) {
        return c.redirect(`${webOrigin}/login?error=account_disabled`)
      }
      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            google_id: googleUser.id,
            avatar_url: googleUser.picture || null,
            email_verified: true,
          },
        },
      )
    } else {
      // New user via Google — always 'user' role unless they're the
      // very first signup (then they get the bootstrap admin slot).
      isNewUser = true
      const userCount = await User.countDocuments()
      const isFirst = userCount === 0
      const id = generateId('usr')
      await User.create({
        _id: id,
        email: emailLower,
        password_hash: null,
        name: googleUser.name,
        role: isFirst ? 'admin' : 'user',
        email_verified: true,
        google_id: googleUser.id,
        avatar_url: googleUser.picture || null,
      } as Parameters<typeof User.create>[0])
      user = await User.findById(id, { _id: 1, email: 1, name: 1, role: 1 }).lean()
    }

    const authUser: AuthUser = {
      id: user!._id,
      email: user!.email,
      name: user!.name,
      role: user!.role,
    }

    const token = await signJwt(authUser)
    setCookie(c, 'corn_token', token, {
      httpOnly: true,
      secure: process.env['NODE_ENV'] === 'production',
      sameSite: 'Lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    })

    // Redirect new Google users to set-password page
    const redirectTo = isNewUser ? `${webOrigin}/set-password?new_google=1` : webOrigin
    return c.redirect(redirectTo)
  } catch (err) {
    console.error('[Google OAuth] error:', err)
    return c.redirect(`${webOrigin}/login?error=google_internal_error`)
  }
})

// ─── Set Password (for Google OAuth users) ───────────────
authRouter.post('/set-password', async (c) => {
  const token = getCookie(c, 'corn_token')
  if (!token) return c.json({ error: 'Not authenticated' }, 401)
  const me = await verifyJwt(token)
  if (!me) return c.json({ error: 'Invalid session' }, 401)

  const body = await c.req.json()
  const { password } = body

  if (!password || password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400)
  }

  const passwordHash = await bcrypt.hash(password, 12)
  await User.updateOne({ _id: me.id }, { $set: { password_hash: passwordHash } })

  return c.json({ ok: true })
})
