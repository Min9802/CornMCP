// API key CRUD. Admin sees every key; users only their own. Raw keys are
// returned ONCE on creation — only the hash is persisted.

import { Hono } from 'hono'
import { hashApiKey } from '@corn/shared-utils'
import { randomBytes } from 'node:crypto'
import { ApiKey } from '../db/mongoose/index.js'
import { jwtAuthMiddleware, getAuthCtx } from '../middleware/auth.js'

export const keysRouter = new Hono()

keysRouter.use('*', jwtAuthMiddleware)

keysRouter.get('/', async (c) => {
  const { user } = getAuthCtx(c)

  const filter = user.role === 'admin' ? {} : { user_id: user.id }
  const docs = await ApiKey.find(filter, {
    _id: 1,
    name: 1,
    scope: 1,
    permissions: 1,
    project_id: 1,
    user_id: 1,
    created_at: 1,
    expires_at: 1,
    last_used_at: 1,
  })
    .sort({ created_at: -1 })
    .lean()

  // Preserve the legacy `id` field shape consumed by the dashboard.
  const keys = docs.map((d) => ({
    id: d._id,
    name: d.name,
    scope: d.scope,
    permissions: d.permissions,
    project_id: d.project_id,
    user_id: d.user_id,
    created_at: d.created_at,
    expires_at: d.expires_at,
    last_used_at: d.last_used_at,
  }))
  return c.json({ keys })
})

keysRouter.post('/', async (c) => {
  const body = await c.req.json()
  const { user } = getAuthCtx(c)
  const { name, scope = 'all', permissions, projectId } = body

  if (!name) return c.json({ error: 'Name required' }, 400)

  const rawKey = randomBytes(32).toString('hex')
  const id = `ck_${randomBytes(4).toString('hex')}`
  const keyHash = hashApiKey(rawKey)

  await ApiKey.create({
    _id: id,
    name,
    key_hash: keyHash,
    scope,
    permissions: permissions ?? null,
    project_id: projectId ?? null,
    user_id: user.id,
  })

  return c.json({
    id,
    key: rawKey,
    name,
    scope,
    message: '⚠️ Save this key — it will not be shown again.',
  })
})

keysRouter.delete('/:id', async (c) => {
  const { id } = c.req.param()
  const { user } = getAuthCtx(c)

  // Non-admin: assert ownership before deleting.
  if (user.role !== 'admin') {
    const key = await ApiKey.findById(id, { user_id: 1 }).lean()
    if (!key) return c.json({ error: 'Key not found' }, 404)
    if (key.user_id !== user.id) return c.json({ error: 'Access denied' }, 403)
  }

  const res = await ApiKey.deleteOne({ _id: id })
  if (res.deletedCount === 0 && user.role === 'admin') {
    // Admin deleting a missing id: surface the same 404 as non-admin.
    return c.json({ error: 'Key not found' }, 404)
  }
  return c.json({ ok: true })
})
