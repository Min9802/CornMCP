import { Hono } from 'hono'
import { dbAll, dbGet, dbRun } from '../db/client.js'
import { jwtAuthMiddleware, apiKeyAuthMiddleware, getAuthCtx, getAgentCtx } from '../middleware/auth.js'

export const usageRouter = new Hono()

// GET — dashboard (JWT)
usageRouter.get('/', jwtAuthMiddleware, async (c) => {
  const { user, keyIds } = getAuthCtx(c)
  const days = Number(c.req.query('days') || '30')

  const keyFilter = user.role !== 'admin' && keyIds.length > 0
    ? `AND agent_id IN (${keyIds.map(() => '?').join(',')})`
    : ''
  const keyParams = user.role !== 'admin' ? keyIds : []

  const totalTokens = await dbGet(
    `SELECT COALESCE(SUM(total_tokens), 0) as total, COUNT(*) as requests
     FROM usage_logs WHERE created_at >= datetime('now', '-' || ? || ' days') ${keyFilter}`,
    [days, ...keyParams],
  )

  const byModel = await dbAll(
    `SELECT model, SUM(prompt_tokens) as prompt_tokens, SUM(completion_tokens) as completion_tokens,
            SUM(total_tokens) as total_tokens, COUNT(*) as requests
     FROM usage_logs WHERE created_at >= datetime('now', '-' || ? || ' days') ${keyFilter}
     GROUP BY model ORDER BY total_tokens DESC`,
    [days, ...keyParams],
  )

  const byAgent = await dbAll(
    `SELECT agent_id, SUM(total_tokens) as total_tokens, COUNT(*) as requests
     FROM usage_logs WHERE created_at >= datetime('now', '-' || ? || ' days') ${keyFilter}
     GROUP BY agent_id ORDER BY total_tokens DESC`,
    [days, ...keyParams],
  )

  const daily = await dbAll(
    `SELECT date(created_at) as date, SUM(total_tokens) as tokens, COUNT(*) as requests
     FROM usage_logs WHERE created_at >= datetime('now', '-' || ? || ' days') ${keyFilter}
     GROUP BY date(created_at) ORDER BY date DESC`,
    [days, ...keyParams],
  )

  return c.json({
    totalTokens: totalTokens?.['total'] || 0,
    totalRequests: totalTokens?.['requests'] || 0,
    byModel,
    byAgent,
    daily,
  })
})

// POST — agent log (API key)
usageRouter.post('/', apiKeyAuthMiddleware, async (c) => {
  const body = await c.req.json()
  const { agentKeyId } = getAgentCtx(c)

  await dbRun(
    `INSERT INTO usage_logs (agent_id, model, prompt_tokens, completion_tokens, total_tokens, project_id, request_type)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      agentKeyId || body.agentId || 'unknown',
      body.model || 'unknown',
      body.promptTokens || 0,
      body.completionTokens || 0,
      body.totalTokens || 0,
      body.projectId || null,
      body.requestType || 'chat',
    ],
  )

  return c.json({ ok: true })
})
