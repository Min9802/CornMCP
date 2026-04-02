import { type Context, type MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { jwtVerify, SignJWT } from 'jose'
import { dbAll, dbGet } from '../db/client.js'
import { hashApiKey } from '@corn/shared-utils'

export interface AuthUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'user'
}

function getJwtSecret(): Uint8Array {
  const secret = process.env['AUTH_JWT_SECRET']
  if (!secret) throw new Error('AUTH_JWT_SECRET environment variable is required')
  return new TextEncoder().encode(secret)
}

export async function signJwt(user: AuthUser): Promise<string> {
  return new SignJWT({ sub: user.id, email: user.email, name: user.name, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('7d')
    .setIssuedAt()
    .sign(getJwtSecret())
}

export async function verifyJwt(token: string): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret())
    return {
      id: payload.sub as string,
      email: payload.email as string,
      name: payload.name as string,
      role: payload.role as 'admin' | 'user',
    }
  } catch {
    return null
  }
}

export function getAuthCtx(c: Context) {
  return {
    user: (c as any).get('authUser') as AuthUser,
    keyIds: ((c as any).get('userKeyIds') as string[]) || [],
    projectIds: ((c as any).get('userProjectIds') as string[]) || [],
  }
}

export function getAgentCtx(c: Context) {
  return {
    agentKeyId: (c as any).get('agentKeyId') as string,
    agentUserId: (c as any).get('agentUserId') as string | null,
    agentUserProjectIds: ((c as any).get('agentUserProjectIds') as string[]) || [],
  }
}

async function loadUserScope(c: Context, userId: string, role: string) {
  if (role === 'admin') {
    const allKeys = await dbAll('SELECT id FROM api_keys')
    const allProjects = await dbAll('SELECT id FROM projects')
    ;(c as any).set('userKeyIds', allKeys.map((k) => k['id'] as string))
    ;(c as any).set('userProjectIds', allProjects.map((p) => p['id'] as string))
  } else {
    const keys = await dbAll('SELECT id FROM api_keys WHERE user_id = ?', [userId])
    const projects = await dbAll(
      `SELECT p.id FROM projects p
       JOIN organizations o ON p.org_id = o.id
       WHERE o.user_id = ?`,
      [userId],
    )
    ;(c as any).set('userKeyIds', keys.map((k) => k['id'] as string))
    ;(c as any).set('userProjectIds', projects.map((p) => p['id'] as string))
  }
}

// ── JWT middleware (for dashboard routes) ─────────────────
export const jwtAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const token = getCookie(c, 'corn_token')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const user = await verifyJwt(token)
  if (!user) return c.json({ error: 'Invalid or expired session' }, 401)
  ;(c as any).set('authUser', user)
  await loadUserScope(c, user.id, user.role)
  await next()
}

// ── Admin-only guard (use after jwtAuthMiddleware) ────────
export const adminOnly: MiddlewareHandler = async (c, next) => {
  const { user } = getAuthCtx(c)
  if (user.role !== 'admin') return c.json({ error: 'Admin access required' }, 403)
  await next()
}

// ── API Key middleware (for agent write routes) ───────────
export const apiKeyAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const rawKey = c.req.header('X-API-Key') || c.req.header('x-api-key')
  if (!rawKey) return c.json({ error: 'API key required (X-API-Key header)' }, 401)

  const keyHash = hashApiKey(rawKey)
  const keyRow = await dbGet(
    'SELECT id, user_id FROM api_keys WHERE key_hash = ?',
    [keyHash],
  )
  if (!keyRow) return c.json({ error: 'Invalid API key' }, 401)

  const agentUserId = keyRow['user_id'] as string | null
  ;(c as any).set('agentKeyId', keyRow['id'] as string)
  ;(c as any).set('agentUserId', agentUserId)

  if (agentUserId) {
    const projects = await dbAll(
      `SELECT p.id FROM projects p
       JOIN organizations o ON p.org_id = o.id
       WHERE o.user_id = ?`,
      [agentUserId],
    )
    ;(c as any).set('agentUserProjectIds', projects.map((p) => p['id'] as string))
  } else {
    ;(c as any).set('agentUserProjectIds', [])
  }

  // Update last_used_at
  await import('../db/client.js').then(({ dbRun }) =>
    dbRun(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`, [keyRow['id'] as string]),
  )
  await next()
}

// ── Any auth: accepts JWT cookie OR API key ───────────────
export const anyAuthMiddleware: MiddlewareHandler = async (c, next) => {
  // Try JWT cookie first
  const token = getCookie(c, 'corn_token')
  if (token) {
    const user = await verifyJwt(token)
    if (user) {
      ;(c as any).set('authUser', user)
      ;(c as any).set('authSource', 'jwt')
      await loadUserScope(c, user.id, user.role)
      await next()
      return
    }
  }

  // Try API key
  const rawKey = c.req.header('X-API-Key') || c.req.header('x-api-key')
  if (rawKey) {
    const keyHash = hashApiKey(rawKey)
    const keyRow = await dbGet('SELECT id, user_id FROM api_keys WHERE key_hash = ?', [keyHash])
    if (keyRow) {
      const agentUserId = keyRow['user_id'] as string | null
      ;(c as any).set('agentKeyId', keyRow['id'] as string)
      ;(c as any).set('agentUserId', agentUserId)
      ;(c as any).set('authSource', 'apikey')

      if (agentUserId) {
        // Load user profile so getAuthCtx() works transparently
        const userRow = await dbGet('SELECT id, email, name, role FROM users WHERE id = ?', [agentUserId])
        if (userRow) {
          ;(c as any).set('authUser', {
            id: userRow['id'] as string,
            email: userRow['email'] as string,
            name: userRow['name'] as string,
            role: userRow['role'] as 'admin' | 'user',
          })
          await loadUserScope(c, agentUserId, userRow['role'] as string)
        }

        const projects = await dbAll(
          `SELECT p.id FROM projects p
           JOIN organizations o ON p.org_id = o.id
           WHERE o.user_id = ?`,
          [agentUserId],
        )
        ;(c as any).set('agentUserProjectIds', projects.map((p) => p['id'] as string))
      } else {
        ;(c as any).set('agentUserProjectIds', [])
      }
      await next()
      return
    }
  }

  return c.json({ error: 'Unauthorized' }, 401)
}

export { getCookie, setCookie, deleteCookie }
