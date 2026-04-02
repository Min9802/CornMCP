import { Hono } from 'hono'
import { dbAll, dbGet, dbRun } from '../db/client.js'
import { generateId, hashApiKey } from '@corn/shared-utils'
import { randomBytes } from 'node:crypto'
import { jwtAuthMiddleware, getAuthCtx } from '../middleware/auth.js'

export const keysRouter = new Hono()

keysRouter.use('*', jwtAuthMiddleware)

keysRouter.get('/', async (c) => {
  const { user } = getAuthCtx(c)

  const keys = user.role === 'admin'
    ? await dbAll(
        'SELECT id, name, scope, permissions, project_id, user_id, created_at, expires_at, last_used_at FROM api_keys ORDER BY created_at DESC',
      )
    : await dbAll(
        'SELECT id, name, scope, permissions, project_id, user_id, created_at, expires_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC',
        [user.id],
      )

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

  await dbRun(
    `INSERT INTO api_keys (id, name, key_hash, scope, permissions, project_id, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, name, keyHash, scope, permissions ? JSON.stringify(permissions) : null, projectId || null, user.id],
  )

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

  if (user.role !== 'admin') {
    const key = await dbGet('SELECT user_id FROM api_keys WHERE id = ?', [id])
    if (!key) return c.json({ error: 'Key not found' }, 404)
    if (key['user_id'] !== user.id) return c.json({ error: 'Access denied' }, 403)
  }

  await dbRun('DELETE FROM api_keys WHERE id = ?', [id])
  return c.json({ ok: true })
})
