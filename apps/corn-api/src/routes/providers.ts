import { Hono } from 'hono'
import { dbAll, dbGet, dbRun } from '../db/client.js'
import { generateId } from '@corn/shared-utils'

export const providersRouter = new Hono()

// ─── List providers ─────────────────────────────────────
providersRouter.get('/', async (c) => {
  const providers = await dbAll('SELECT * FROM provider_accounts ORDER BY created_at DESC')
  return c.json({ providers })
})

// ─── Create provider ────────────────────────────────────
providersRouter.post('/', async (c) => {
  const body = await c.req.json()
  const id = generateId('prov')

  await dbRun(
    `INSERT INTO provider_accounts (id, name, type, auth_type, api_base, api_key, status, capabilities, models)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      body.name,
      body.type || 'openai',
      body.authType || 'api_key',
      body.apiBase,
      body.apiKey || null,
      body.status || 'enabled',
      JSON.stringify(body.capabilities || ['chat']),
      JSON.stringify(body.models || []),
    ],
  )

  return c.json({ ok: true, id })
})

// ─── Update provider ────────────────────────────────────
providersRouter.patch('/:id', async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json()

  const fields: string[] = []
  const values: unknown[] = []

  if (body.name) { fields.push('name = ?'); values.push(body.name) }
  if (body.status) { fields.push('status = ?'); values.push(body.status) }
  if (body.apiBase) { fields.push('api_base = ?'); values.push(body.apiBase) }
  if (body.apiKey) { fields.push('api_key = ?'); values.push(body.apiKey) }
  if (body.models) { fields.push('models = ?'); values.push(JSON.stringify(body.models)) }
  if (body.capabilities) { fields.push('capabilities = ?'); values.push(JSON.stringify(body.capabilities)) }

  fields.push("updated_at = datetime('now')")
  values.push(id)

  await dbRun(`UPDATE provider_accounts SET ${fields.join(', ')} WHERE id = ?`, values)
  return c.json({ ok: true })
})

// ─── Delete provider ────────────────────────────────────
providersRouter.delete('/:id', async (c) => {
  const { id } = c.req.param()
  await dbRun('DELETE FROM provider_accounts WHERE id = ?', [id])
  return c.json({ ok: true })
})
