import { type Context, type MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { jwtVerify, SignJWT } from 'jose'
import { hashApiKey } from '@corn/shared-utils'
import { ApiKey, Organization, Project, User } from '../db/mongoose/index.js'

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

// Resolve the API keys + projects this user can act on. The original SQL
// used a single JOIN against organizations.user_id to find projects in
// the user's orgs; in Mongo we issue two queries (orgs by user_id, then
// projects by org_id list). Cardinality is small enough that the round
// trip cost is negligible.
async function loadUserScope(c: Context, userId: string, role: string) {
  if (role === 'admin') {
    const [allKeys, allProjects] = await Promise.all([
      ApiKey.find({}, { _id: 1 }).lean(),
      Project.find({}, { _id: 1 }).lean(),
    ])
    ;(c as any).set('userKeyIds', allKeys.map((k) => k._id))
    ;(c as any).set('userProjectIds', allProjects.map((p) => p._id))
    return
  }

  const orgs = await Organization.find({ user_id: userId }, { _id: 1 }).lean()
  const orgIds = orgs.map((o) => o._id)

  const [keys, projects] = await Promise.all([
    ApiKey.find({ user_id: userId }, { _id: 1 }).lean(),
    Project.find({ org_id: { $in: orgIds } }, { _id: 1 }).lean(),
  ])
  ;(c as any).set('userKeyIds', keys.map((k) => k._id))
  ;(c as any).set('userProjectIds', projects.map((p) => p._id))
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

// Resolve every project visible to a given API-key holder.
// Same two-query strategy as loadUserScope() above. The agent only sees
// projects in orgs it explicitly owns — no shared-org back door.
async function loadAgentProjectIds(agentUserId: string): Promise<string[]> {
  const orgs = await Organization.find({ user_id: agentUserId }, { _id: 1 }).lean()
  const orgIds = orgs.map((o) => o._id)
  if (orgIds.length === 0) return []
  const projects = await Project.find({ org_id: { $in: orgIds } }, { _id: 1 }).lean()
  return projects.map((p) => p._id)
}

// ── API Key middleware (for agent write routes) ───────────
export const apiKeyAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const rawKey = c.req.header('X-API-Key') || c.req.header('x-api-key')
  if (!rawKey) return c.json({ error: 'API key required (X-API-Key header)' }, 401)

  const keyHash = hashApiKey(rawKey)
  const keyRow = await ApiKey.findOne({ key_hash: keyHash }, { _id: 1, user_id: 1 }).lean()
  if (!keyRow) return c.json({ error: 'Invalid API key' }, 401)

  const agentUserId = keyRow.user_id ?? null
  ;(c as any).set('agentKeyId', keyRow._id)
  ;(c as any).set('agentUserId', agentUserId)

  const projectIds = agentUserId ? await loadAgentProjectIds(agentUserId) : []
  ;(c as any).set('agentUserProjectIds', projectIds)

  // Update last_used_at — fire and forget so the request doesn't wait
  // for the audit write to land.
  void ApiKey.updateOne({ _id: keyRow._id }, { $set: { last_used_at: new Date() } })

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
    const keyRow = await ApiKey.findOne({ key_hash: keyHash }, { _id: 1, user_id: 1 }).lean()
    if (keyRow) {
      const agentUserId = keyRow.user_id ?? null
      ;(c as any).set('agentKeyId', keyRow._id)
      ;(c as any).set('agentUserId', agentUserId)
      ;(c as any).set('authSource', 'apikey')

      if (agentUserId) {
        // Load user profile so getAuthCtx() works transparently
        const userRow = await User.findById(agentUserId, {
          _id: 1,
          email: 1,
          name: 1,
          role: 1,
        }).lean()
        if (userRow) {
          ;(c as any).set('authUser', {
            id: userRow._id,
            email: userRow.email,
            name: userRow.name,
            role: userRow.role,
          })
          await loadUserScope(c, agentUserId, userRow.role)
        }

        ;(c as any).set('agentUserProjectIds', await loadAgentProjectIds(agentUserId))
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
