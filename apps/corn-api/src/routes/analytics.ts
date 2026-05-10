import { Hono } from 'hono'
import { QueryLog } from '../db/mongoose/index.js'
import { anyAuthMiddleware, getAuthCtx } from '../middleware/auth.js'

export const analyticsRouter = new Hono()

analyticsRouter.use('*', anyAuthMiddleware)

// ─── Tool analytics ─────────────────────────────────────
analyticsRouter.get('/tool-analytics', async (c) => {
  const { user, keyIds } = getAuthCtx(c)
  const days = Number(c.req.query('days') || '7')
  const agentId = c.req.query('agentId')
  const projectId = c.req.query('projectId')

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const match: Record<string, unknown> = { created_at: { $gte: since } }

  // Scope to user's keys unless admin. If a non-admin has zero keys we must
  // force the result set to empty — falling through with no filter would leak
  // every other user's query logs (the agent_id column has no user_id FK).
  if (user.role !== 'admin') {
    match.agent_id = keyIds.length === 0 ? { $in: [] as string[] } : { $in: keyIds }
  }
  if (agentId) match.agent_id = agentId
  if (projectId) match.project_id = projectId

  // The summary, per-tool, per-agent, and trend pipelines all share the same
  // time + ownership $match prefix; only the $group key changes.
  // estimatedTokensSaved reads from tokens_saved (estimation produced by
  // apps/corn-mcp/src/telemetry/estimate.ts), NOT compute_tokens which is
  // the actual usage and would invert the meaning of the metric.
  const round1 = (n: number) => Math.round(n * 10) / 10
  const round0 = (n: number) => Math.round(n)

  const [summaryAgg, tools, agents, trend] = await Promise.all([
    QueryLog.aggregate<{
      totalCalls: number
      okCalls: number
      tokens_saved: number
      total_bytes: number
      activeAgents: string[]
    }>([
      { $match: match },
      {
        $group: {
          _id: null,
          totalCalls: { $sum: 1 },
          okCalls: { $sum: { $cond: [{ $eq: ['$status', 'ok'] }, 1, 0] } },
          tokens_saved: { $sum: '$tokens_saved' },
          total_bytes: { $sum: { $add: ['$input_size', '$output_size'] } },
          activeAgents: { $addToSet: '$agent_id' },
        },
      },
    ]),
    QueryLog.aggregate<{
      tool: string
      totalCalls: number
      okCalls: number
      errorCount: number
      avgLatencyMs: number
    }>([
      { $match: match },
      {
        $group: {
          _id: '$tool',
          totalCalls: { $sum: 1 },
          okCalls: { $sum: { $cond: [{ $eq: ['$status', 'ok'] }, 1, 0] } },
          errorCount: { $sum: { $cond: [{ $ne: ['$status', 'ok'] }, 1, 0] } },
          avgLatencyMs: { $avg: '$latency_ms' },
        },
      },
      { $sort: { totalCalls: -1 } },
      { $project: { _id: 0, tool: '$_id', totalCalls: 1, okCalls: 1, errorCount: 1, avgLatencyMs: 1 } },
    ]),
    QueryLog.aggregate<{
      agentId: string
      totalCalls: number
      okCalls: number
    }>([
      { $match: match },
      {
        $group: {
          _id: '$agent_id',
          totalCalls: { $sum: 1 },
          okCalls: { $sum: { $cond: [{ $eq: ['$status', 'ok'] }, 1, 0] } },
        },
      },
      { $sort: { totalCalls: -1 } },
      { $project: { _id: 0, agentId: '$_id', totalCalls: 1, okCalls: 1 } },
    ]),
    QueryLog.aggregate<{ day: string; calls: number; errors: number }>([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } },
          calls: { $sum: 1 },
          errors: { $sum: { $cond: [{ $ne: ['$status', 'ok'] }, 1, 0] } },
        },
      },
      { $sort: { _id: -1 } },
      { $limit: 30 },
      { $project: { _id: 0, day: '$_id', calls: 1, errors: 1 } },
    ]),
  ])

  const summary = summaryAgg[0]
  const totalCalls = summary?.totalCalls ?? 0
  const overallSuccessRate = totalCalls > 0
    ? round1((100 * (summary?.okCalls ?? 0)) / totalCalls)
    : 0

  // Apply per-row rounding to match the legacy SQL `ROUND(..., 1)` /
  // `ROUND(..., 0)` semantics so the dashboard renders stable numbers.
  const toolsOut = tools.map((t) => ({
    tool: t.tool,
    totalCalls: t.totalCalls,
    successRate: t.totalCalls > 0 ? round1((100 * t.okCalls) / t.totalCalls) : 0,
    errorCount: t.errorCount,
    avgLatencyMs: round0(t.avgLatencyMs ?? 0),
  }))

  const agentsOut = agents.map((a) => ({
    agentId: a.agentId,
    totalCalls: a.totalCalls,
    successRate: a.totalCalls > 0 ? round1((100 * a.okCalls) / a.totalCalls) : 0,
  }))

  return c.json({
    summary: {
      totalCalls,
      overallSuccessRate,
      estimatedTokensSaved: summary?.tokens_saved ?? 0,
      totalDataBytes: summary?.total_bytes ?? 0,
      activeAgents: summary?.activeAgents?.length ?? 0,
    },
    tools: toolsOut,
    agents: agentsOut,
    trend,
  })
})
