import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
import { dbGet, dbRun, dbAll } from '../db/client.js'
import { generateId, hashApiKey } from '@corn/shared-utils'
import { signJwt, verifyJwt, getCookie, setCookie, deleteCookie, type AuthUser } from '../middleware/auth.js'

export const authRouter = new Hono()

// ─── Register ────────────────────────────────────────────
// First user → auto admin. Subsequent users → admin JWT required.
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

  await dbRun(
    `INSERT INTO users (id, email, password_hash, name, role, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [id, email.toLowerCase(), passwordHash, name, role],
  )

  return c.json({ ok: true, id, role }, 201)
})

// ─── Login ───────────────────────────────────────────────
authRouter.post('/login', async (c) => {
  const body = await c.req.json()
  const { email, password } = body

  if (!email || !password) return c.json({ error: 'email and password are required' }, 400)

  const row = await dbGet(
    'SELECT id, email, name, role, password_hash FROM users WHERE email = ? AND is_active = 1',
    [email.toLowerCase()],
  )
  if (!row) return c.json({ error: 'Invalid email or password' }, 401)

  const valid = await bcrypt.compare(password, row['password_hash'] as string)
  if (!valid) return c.json({ error: 'Invalid email or password' }, 401)

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
