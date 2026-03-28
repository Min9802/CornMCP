import { Hono } from 'hono'
import { dbAll, dbRun } from '../db/client.js'
import { generateId, hashApiKey } from '@corn/shared-utils'
import { randomBytes } from 'node:crypto'

export const keysRouter = new Hono()

keysRouter.get('/', async (c) => {
  const keys = await dbAll(
    'SELECT id, name, scope, permissions, project_id, created_at, expires_at, last_used_at FROM api_keys ORDER BY created_at DESC',
  )
  return c.json({ keys })
})

keysRouter.post('/', async (c) => {
  const body = await c.req.json()
  const { name, scope = 'all', permissions, projectId } = body

  if (!name) return c.json({ error: 'Name required' }, 400)

  const rawKey = randomBytes(32).toString('hex')
  const id = `ck_${randomBytes(4).toString('hex')}`
  const keyHash = hashApiKey(rawKey)

  await dbRun(
    `INSERT INTO api_keys (id, name, key_hash, scope, permissions, project_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, name, keyHash, scope, permissions ? JSON.stringify(permissions) : null, projectId || null],
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
  await dbRun('DELETE FROM api_keys WHERE id = ?', [id])
  return c.json({ ok: true })
})
