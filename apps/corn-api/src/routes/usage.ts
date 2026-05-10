import { Hono } from 'hono'
import { UsageLog } from '../db/mongoose/index.js'
import { jwtAuthMiddleware, apiKeyAuthMiddleware, getAuthCtx, getAgentCtx } from '../middleware/auth.js'

export const usageRouter = new Hono()

// GET — dashboard (JWT)
usageRouter.get('/', jwtAuthMiddleware, async (c) => {
  const { user, keyIds } = getAuthCtx(c)
  const days = Number(c.req.query('days') || '30')

  // Non-admin with zero keys must see zero rows — usage_logs has no user_id
  // column, so the only scope handle is agent_id (= api_keys.id). Falling
  // through with no filter would leak every other tenant's tokens.
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const baseMatch: Record<string, unknown> = { created_at: { $gte: since } }
  if (user.role !== 'admin') {
    if (keyIds.length === 0) {
      // No keys → no rows. Match an impossible agent_id rather than leaking
      // every tenant's tokens (mirrors `AND 1=0` in the legacy SQL).
      baseMatch.agent_id = { $in: [] as string[] }
    } else {
      baseMatch.agent_id = { $in: keyIds }
    }
  }

  const [totalsAgg, byModel, byAgent, daily] = await Promise.all([
    UsageLog.aggregate<{ total: number; requests: number }>([
      { $match: baseMatch },
      {
        $group: {
          _id: null,
          total: { $sum: '$total_tokens' },
          requests: { $sum: 1 },
        },
      },
    ]),
    UsageLog.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: '$model',
          prompt_tokens: { $sum: '$prompt_tokens' },
          completion_tokens: { $sum: '$completion_tokens' },
          total_tokens: { $sum: '$total_tokens' },
          requests: { $sum: 1 },
        },
      },
      { $sort: { total_tokens: -1 } },
      { $project: { _id: 0, model: '$_id', prompt_tokens: 1, completion_tokens: 1, total_tokens: 1, requests: 1 } },
    ]),
    UsageLog.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: '$agent_id',
          total_tokens: { $sum: '$total_tokens' },
          requests: { $sum: 1 },
        },
      },
      { $sort: { total_tokens: -1 } },
      { $project: { _id: 0, agent_id: '$_id', total_tokens: 1, requests: 1 } },
    ]),
    UsageLog.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } },
          tokens: { $sum: '$total_tokens' },
          requests: { $sum: 1 },
        },
      },
      { $sort: { _id: -1 } },
      { $project: { _id: 0, date: '$_id', tokens: 1, requests: 1 } },
    ]),
  ])

  const totals = totalsAgg[0] ?? { total: 0, requests: 0 }
  return c.json({
    totalTokens: totals.total || 0,
    totalRequests: totals.requests || 0,
    byModel,
    byAgent,
    daily,
  })
})

// POST — agent log (API key)
usageRouter.post('/', apiKeyAuthMiddleware, async (c) => {
  const body = await c.req.json()
  const { agentKeyId } = getAgentCtx(c)

  await UsageLog.create({
    agent_id: agentKeyId || body.agentId || 'unknown',
    model: body.model || 'unknown',
    prompt_tokens: body.promptTokens || 0,
    completion_tokens: body.completionTokens || 0,
    total_tokens: body.totalTokens || 0,
    project_id: body.projectId || null,
    request_type: body.requestType || 'chat',
  } as Parameters<typeof UsageLog.create>[0])

  return c.json({ ok: true })
})
