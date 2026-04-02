import { Hono } from 'hono'
import { dbAll, dbGet, dbRun } from '../db/client.js'
import { generateId } from '@corn/shared-utils'
import { jwtAuthMiddleware, getAuthCtx } from '../middleware/auth.js'

export const providersRouter = new Hono()

// ── Copilot/GitHub provider presets ──────────────────────
const PROVIDER_PRESETS: Record<string, { apiBase: string; authType: string; models: string[] }> = {
  copilot: {
    apiBase: 'https://api.githubcopilot.com/v1',
    authType: 'bearer',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'claude-3.7-sonnet', 'claude-sonnet-4-5'],
  },
  'github-models': {
    apiBase: 'https://models.inference.ai.azure.com',
    authType: 'bearer',
    models: ['gpt-4o', 'gpt-4.5-turbo', 'Meta-Llama-3.1-70B-Instruct', 'Mistral-large-2411', 'DeepSeek-V3'],
  },
}

providersRouter.use('*', jwtAuthMiddleware)

// ─── List providers ──────────────────────────────────────
providersRouter.get('/', async (c) => {
  const { user } = getAuthCtx(c)

  const providers = user.role === 'admin'
    ? await dbAll('SELECT * FROM provider_accounts ORDER BY created_at DESC')
    : await dbAll('SELECT * FROM provider_accounts WHERE user_id = ? ORDER BY created_at DESC', [user.id])

  return c.json({ providers })
})

// ─── Create provider ─────────────────────────────────────
providersRouter.post('/', async (c) => {
  const body = await c.req.json()
  const { user } = getAuthCtx(c)
  const id = generateId('prov')

  const type = body.type || 'openai'
  const preset = PROVIDER_PRESETS[type]
  const apiBase = body.apiBase || preset?.apiBase || ''
  const authType = body.authType || preset?.authType || 'api_key'
  const models = body.models?.length ? body.models : (preset?.models || [])

  if (!apiBase) return c.json({ error: 'api_base is required' }, 400)

  await dbRun(
    `INSERT INTO provider_accounts (id, name, type, auth_type, api_base, api_key, status, capabilities, models, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      body.name || type,
      type,
      authType,
      apiBase,
      body.apiKey || null,
      body.status || 'enabled',
      JSON.stringify(body.capabilities || ['chat']),
      JSON.stringify(models),
      user.id,
    ],
  )

  return c.json({ ok: true, id })
})

// ─── Update provider ─────────────────────────────────────
providersRouter.patch('/:id', async (c) => {
  const { id } = c.req.param()
  const { user } = getAuthCtx(c)
  const body = await c.req.json()

  if (user.role !== 'admin') {
    const p = await dbGet('SELECT user_id FROM provider_accounts WHERE id = ?', [id])
    if (!p) return c.json({ error: 'Provider not found' }, 404)
    if (p['user_id'] !== user.id) return c.json({ error: 'Access denied' }, 403)
  }

  const fields: string[] = []
  const values: unknown[] = []

  if (body.name) { fields.push('name = ?'); values.push(body.name) }
  if (body.status) { fields.push('status = ?'); values.push(body.status) }
  if (body.apiBase) { fields.push('api_base = ?'); values.push(body.apiBase) }
  if (body.apiKey !== undefined) { fields.push('api_key = ?'); values.push(body.apiKey || null) }
  if (body.models) { fields.push('models = ?'); values.push(JSON.stringify(body.models)) }
  if (body.capabilities) { fields.push('capabilities = ?'); values.push(JSON.stringify(body.capabilities)) }

  fields.push("updated_at = datetime('now')")
  values.push(id)

  await dbRun(`UPDATE provider_accounts SET ${fields.join(', ')} WHERE id = ?`, values)
  return c.json({ ok: true })
})

// ─── Delete provider ─────────────────────────────────────
providersRouter.delete('/:id', async (c) => {
  const { id } = c.req.param()
  const { user } = getAuthCtx(c)

  if (user.role !== 'admin') {
    const p = await dbGet('SELECT user_id FROM provider_accounts WHERE id = ?', [id])
    if (!p) return c.json({ error: 'Provider not found' }, 404)
    if (p['user_id'] !== user.id) return c.json({ error: 'Access denied' }, 403)
  }

  await dbRun('DELETE FROM provider_accounts WHERE id = ?', [id])
  return c.json({ ok: true })
})

// ─── Get presets info (for frontend) ─────────────────────
providersRouter.get('/presets', (c) => {
  return c.json({ presets: PROVIDER_PRESETS })
})
