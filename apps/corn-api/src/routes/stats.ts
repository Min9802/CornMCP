import { Hono } from 'hono'
import type { QueryFilter } from 'mongoose'
import {
  ApiKey,
  KnowledgeDocument,
  type KnowledgeDocumentDoc,
  Organization,
  Project,
  type ProjectDoc,
  QualityReport,
  type QualityReportDoc,
  QueryLog,
  type QueryLogDoc,
  SessionHandoff,
  type SessionHandoffDoc,
} from '../db/mongoose/index.js'
import { apiKeyAuthMiddleware, jwtAuthMiddleware, getAuthCtx, getAgentCtx } from '../middleware/auth.js'
import { touchSessionsByAgent } from '../services/session-lifecycle.js'

export const metricsRouter = new Hono()

// Build an `agent_id` clause that mirrors the legacy SQL behavior:
// admin → no filter; non-admin → restrict to owned keys; zero keys → empty result.
function agentIdClause(isAdmin: boolean, keyIds: string[]): { $in: string[] } | null {
  if (isAdmin) return null
  return { $in: keyIds.length > 0 ? keyIds : ([] as string[]) }
}

// ─── Log a query (called by MCP server / API key) ────────
// This endpoint also doubles as an implicit heartbeat for the agent's active
// sessions: every tool call → telemetry → touchSessionsByAgent → keep-alive.
// Without this, sessions auto-close after SESSION_AUTO_CLOSE_MINUTES even if
// the agent is still actively running tools.
metricsRouter.post('/query-log', apiKeyAuthMiddleware, async (c) => {
  const body = await c.req.json()
  const { agentKeyId } = getAgentCtx(c)
  const agentId = agentKeyId || body.agentId || 'unknown'

  await QueryLog.create({
    agent_id: agentId,
    tool: body.tool || 'unknown',
    params: body.params ?? null,
    latency_ms: body.latencyMs || 0,
    status: body.status || 'ok',
    error: body.error || null,
    project_id: body.projectId || null,
    input_size: body.inputSize || 0,
    output_size: body.outputSize || 0,
    compute_tokens: body.computeTokens || 0,
    tokens_saved: body.tokensSaved || 0,
    compute_model: body.computeModel || null,
  } as Parameters<typeof QueryLog.create>[0])

  // Implicit heartbeat — bump last_activity_at on every active session of
  // this agent. Skips 'unknown' to avoid touching everyone's stale rows.
  if (agentId !== 'unknown') {
    await touchSessionsByAgent(agentId)
  }

  return c.json({ ok: true })
})

// ─── Get activity feed (JWT) ─────────────────────────────
metricsRouter.get('/activity', jwtAuthMiddleware, async (c) => {
  const { user, keyIds } = getAuthCtx(c)
  const isAdmin = user.role === 'admin'
  const limit = Number(c.req.query('limit') || '20')

  const filter: QueryFilter<QueryLogDoc> = {}
  const ac = agentIdClause(isAdmin, keyIds)
  if (ac) filter.agent_id = ac

  const rows = await QueryLog.find(filter, {
    _id: 1, agent_id: 1, tool: 1, status: 1, latency_ms: 1, created_at: 1,
  })
    .sort({ created_at: -1 })
    .limit(limit)
    .lean()

  const activity = rows.map((r) => ({
    type: 'query',
    detail: r.tool,
    agent_id: r.agent_id,
    status: r.status,
    latency_ms: r.latency_ms,
    created_at: r.created_at,
  }))

  return c.json({ activity })
})

// ─── Dashboard overview (JWT) ─────────────────────────────
metricsRouter.get('/overview', jwtAuthMiddleware, async (c) => {
  const { user, keyIds, projectIds } = getAuthCtx(c)
  const isAdmin = user.role === 'admin'

  // Empty scope must mean zero rows for non-admin, otherwise the dashboard
  // overview leaks every other user's queries / projects / quality reports.
  const queryLogScope: QueryFilter<QueryLogDoc> = {}
  const ac = agentIdClause(isAdmin, keyIds)
  if (ac) queryLogScope.agent_id = ac

  const projectScope: QueryFilter<ProjectDoc> = {}
  if (!isAdmin) {
    projectScope._id = projectIds.length > 0 ? { $in: projectIds } : { $in: [] as string[] }
  }

  const qualityScope: QueryFilter<QualityReportDoc> = {}
  if (!isAdmin) {
    qualityScope.project_id = projectIds.length > 0 ? { $in: projectIds } : { $in: [] as string[] }
  }

  // Knowledge: own document OR shared via accessible project. Mirror legacy
  // `(user_id = ? OR project_id IN (...))` predicate for non-admin only.
  const knowledgeScope: QueryFilter<KnowledgeDocumentDoc> = {}
  if (!isAdmin) {
    const owners: QueryFilter<KnowledgeDocumentDoc>[] = [{ user_id: user.id }]
    if (projectIds.length > 0) owners.push({ project_id: { $in: projectIds } })
    knowledgeScope.$or = owners
  }

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const todayMatch: QueryFilter<QueryLogDoc> = { ...queryLogScope, created_at: { $gte: startOfToday } }
  const sevenDayMatch: QueryFilter<QueryLogDoc> = { ...queryLogScope, created_at: { $gte: sevenDaysAgo } }
  const qualityTodayMatch: QueryFilter<QualityReportDoc> = { ...qualityScope, created_at: { $gte: startOfToday } }

  const [
    projects,
    todayCount,
    distinctAgentsAgg,
    lastQuality,
    avgScoreAgg,
    qualityTodayCount,
    kbDocsCount,
    kbHitsAgg,
    keysCount,
    orgsCount,
    sessionsCount,
    toolCallsAgg,
  ] = await Promise.all([
    Project.find(projectScope).lean(),
    QueryLog.countDocuments(todayMatch),
    QueryLog.aggregate<{ count: number }>([
      { $match: sevenDayMatch },
      { $group: { _id: null, agents: { $addToSet: '$agent_id' } } },
      { $project: { _id: 0, count: { $size: '$agents' } } },
    ]),
    QualityReport.findOne(qualityScope, { grade: 1, score_total: 1 })
      .sort({ created_at: -1 })
      .lean(),
    QualityReport.aggregate<{ avg: number }>([
      { $match: qualityScope },
      { $group: { _id: null, avg: { $avg: '$score_total' } } },
    ]),
    QualityReport.countDocuments(qualityTodayMatch),
    KnowledgeDocument.countDocuments(knowledgeScope),
    KnowledgeDocument.aggregate<{ total: number }>([
      { $match: knowledgeScope },
      { $group: { _id: null, total: { $sum: '$hit_count' } } },
    ]),
    isAdmin
      ? ApiKey.countDocuments()
      : ApiKey.countDocuments({ user_id: user.id }),
    isAdmin
      ? Organization.countDocuments()
      : Organization.countDocuments({ user_id: user.id }),
    // session_handoffs schema has no `agent_id` field — the legacy SQL also
    // referenced a non-existent column for non-admin users. We preserve that
    // semantic: non-admin → empty $in clause → 0 rows; admin → unfiltered total.
    SessionHandoff.countDocuments(queryLogScope as unknown as QueryFilter<SessionHandoffDoc>),
    QueryLog.aggregate<{
      count: number
      compute_tokens: number
      tokens_saved: number
    }>([
      { $match: queryLogScope },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          compute_tokens: { $sum: '$compute_tokens' },
          tokens_saved: { $sum: '$tokens_saved' },
        },
      },
    ]),
  ])

  const totalAgents = distinctAgentsAgg[0]?.count ?? 0
  const avgScore = avgScoreAgg[0]?.avg ?? 0
  const kbHits = kbHitsAgg[0]?.total ?? 0
  const tc = toolCallsAgg[0] ?? { count: 0, compute_tokens: 0, tokens_saved: 0 }
  const totalCalls = Number(tc.count || 0)
  const totalCompute = Number(tc.compute_tokens || 0)
  const totalSaved = Number(tc.tokens_saved || 0)
  const avg = (n: number) => (totalCalls > 0 ? Math.round(n / totalCalls) : 0)

  return c.json({
    projects,
    totalAgents,
    today: { queries: todayCount, sessions: 0 },
    quality: {
      lastGrade: lastQuality?.grade || '—',
      averageScore: Math.round(avgScore || 0),
      reportsToday: qualityTodayCount,
    },
    knowledge: {
      totalDocs: kbDocsCount,
      totalChunks: 0,
      totalHits: kbHits,
    },
    activeKeys: keysCount,
    totalSessions: sessionsCount,
    organizations: orgsCount,
    uptime: Math.floor(process.uptime()),
    tokenSavings: {
      totalTokensSaved: totalSaved,
      totalToolCalls: totalCalls,
      avgTokensPerCall: avg(totalSaved),
      topTools: [],
    },
    tokenUsage: {
      totalComputeTokens: totalCompute,
      totalToolCalls: totalCalls,
      avgTokensPerCall: avg(totalCompute),
    },
  })
})

// ─── Hints engine (API key — agent request) ──────────────
metricsRouter.get('/hints/:agentId', apiKeyAuthMiddleware, async (c) => {
  const currentTool = c.req.query('currentTool') || ''
  const hints: string[] = []

  if (currentTool === 'corn_session_start') {
    hints.push('💡 Use corn_memory_search to recall context from previous sessions')
  }
  if (currentTool === 'corn_memory_store') {
    hints.push('💡 Consider also storing in corn_knowledge_store for team-wide sharing')
  }
  if (currentTool === 'corn_session_end') {
    hints.push('💡 Run corn_quality_report before ending to track quality metrics')
  }

  return c.json({ hints })
})
