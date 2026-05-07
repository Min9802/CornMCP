import { Hono } from 'hono'
import { dbAll, dbGet, dbRun } from '../db/client.js'
import { apiKeyAuthMiddleware, jwtAuthMiddleware, getAuthCtx, getAgentCtx } from '../middleware/auth.js'
import { touchSessionsByAgent } from '../services/session-lifecycle.js'

export const metricsRouter = new Hono()

// ─── Log a query (called by MCP server / API key) ────────
// This endpoint also doubles as an implicit heartbeat for the agent's active
// sessions: every tool call → telemetry → touchSessionsByAgent → keep-alive.
// Without this, sessions auto-close after SESSION_AUTO_CLOSE_MINUTES even if
// the agent is still actively running tools.
metricsRouter.post('/query-log', apiKeyAuthMiddleware, async (c) => {
  const body = await c.req.json()
  const { agentKeyId } = getAgentCtx(c)
  const agentId = agentKeyId || body.agentId || 'unknown'

  await dbRun(
    `INSERT INTO query_logs (agent_id, tool, params, latency_ms, status, error, project_id, input_size, output_size, compute_tokens, tokens_saved, compute_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      agentId,
      body.tool || 'unknown',
      body.params ? JSON.stringify(body.params) : null,
      body.latencyMs || 0,
      body.status || 'ok',
      body.error || null,
      body.projectId || null,
      body.inputSize || 0,
      body.outputSize || 0,
      body.computeTokens || 0,
      body.tokensSaved || 0,
      body.computeModel || null,
    ],
  )

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
  const limit = Number(c.req.query('limit') || '20')

  // Non-admin with zero keys must collapse to zero rows. query_logs has no
  // user_id column, so dropping the filter would expose other tenants.
  const keyFilter = user.role === 'admin'
    ? ''
    : keyIds.length > 0
    ? `AND agent_id IN (${keyIds.map(() => '?').join(',')})`
    : 'AND 1=0'
  const keyParams = user.role !== 'admin' && keyIds.length > 0 ? keyIds : []

  const rows = await dbAll(
    `SELECT id, agent_id, tool, status, latency_ms, created_at
     FROM query_logs WHERE 1=1 ${keyFilter} ORDER BY created_at DESC LIMIT ?`,
    [...keyParams, limit],
  )

  const activity = rows.map((r) => ({
    type: 'query',
    detail: r['tool'],
    agent_id: r['agent_id'],
    status: r['status'],
    latency_ms: r['latency_ms'],
    created_at: r['created_at'],
  }))

  return c.json({ activity })
})

// ─── Dashboard overview (JWT) ─────────────────────────────
metricsRouter.get('/overview', jwtAuthMiddleware, async (c) => {
  const { user, keyIds, projectIds } = getAuthCtx(c)
  const isAdmin = user.role === 'admin'

  // Empty scope must mean zero rows for non-admin, otherwise the dashboard
  // overview leaks every other user's queries / projects / quality reports.
  const kf = isAdmin ? '' : keyIds.length > 0
    ? `AND agent_id IN (${keyIds.map(() => '?').join(',')})` : 'AND 1=0'
  const kp = !isAdmin && keyIds.length > 0 ? keyIds : []
  const pf = isAdmin ? '' : projectIds.length > 0
    ? `AND id IN (${projectIds.map(() => '?').join(',')})` : 'AND 1=0'
  const pp = !isAdmin && projectIds.length > 0 ? projectIds : []

  const projects = await dbAll(`SELECT * FROM projects WHERE 1=1 ${pf}`, pp)

  const today = await dbGet(
    `SELECT COUNT(*) as queries FROM query_logs
     WHERE created_at >= datetime('now', 'start of day') ${kf}`,
    kp,
  )

  const agents = await dbGet(
    `SELECT COUNT(DISTINCT agent_id) as count FROM query_logs
     WHERE created_at >= datetime('now', '-7 days') ${kf}`,
    kp,
  )

  const qpf = isAdmin ? '' : projectIds.length > 0
    ? `AND project_id IN (${projectIds.map(() => '?').join(',')})` : 'AND 1=0'
  const qpp = !isAdmin && projectIds.length > 0 ? projectIds : []

  const lastQuality = await dbGet(
    `SELECT grade, score_total FROM quality_reports WHERE 1=1 ${qpf} ORDER BY created_at DESC LIMIT 1`,
    qpp,
  )
  const avgScore = await dbGet(`SELECT AVG(score_total) as avg FROM quality_reports WHERE 1=1 ${qpf}`, qpp)
  const qualityToday = await dbGet(
    `SELECT COUNT(*) as count FROM quality_reports
     WHERE created_at >= datetime('now', 'start of day') ${qpf}`,
    qpp,
  )

  const kbpf = !isAdmin
    ? `WHERE (user_id = '${user.id}'${projectIds.length > 0 ? ` OR project_id IN (${projectIds.map(() => '?').join(',')})` : ''})` : ''
  const kbpp = !isAdmin && projectIds.length > 0 ? projectIds : []

  const kbDocs = await dbGet(`SELECT COUNT(*) as count FROM knowledge_documents ${kbpf}`, kbpp)
  const kbHits = await dbGet(`SELECT COALESCE(SUM(hit_count), 0) as total FROM knowledge_documents ${kbpf}`, kbpp)

  const keysCount = await dbGet(
    isAdmin ? 'SELECT COUNT(*) as count FROM api_keys' : 'SELECT COUNT(*) as count FROM api_keys WHERE user_id = ?',
    isAdmin ? [] : [user.id],
  )
  const orgsCount = await dbGet(
    isAdmin ? 'SELECT COUNT(*) as count FROM organizations' : 'SELECT COUNT(*) as count FROM organizations WHERE user_id = ?',
    isAdmin ? [] : [user.id],
  )
  const sessionsCount = await dbGet(
    `SELECT COUNT(*) as count FROM session_handoffs WHERE 1=1 ${kf}`,
    kp,
  )
  // Pull both metrics in a single scan: actual compute usage and the
  // estimated tokens saved by routing context through MCP. Both columns are
  // populated by the producer (apps/corn-mcp/src/telemetry/estimate.ts).
  // The kf filter (`agent_id IN (keyIds)`) keeps the result per-user; for
  // non-admin with zero keys it collapses to 1=0 → all sums come back as 0.
  const toolCalls = await dbGet(
    `SELECT COUNT(*) as count,
            COALESCE(SUM(compute_tokens), 0) as compute_tokens,
            COALESCE(SUM(tokens_saved), 0) as tokens_saved
     FROM query_logs WHERE 1=1 ${kf}`,
    kp,
  )

  const totalCalls = Number(toolCalls?.['count'] || 0)
  const totalCompute = Number(toolCalls?.['compute_tokens'] || 0)
  const totalSaved = Number(toolCalls?.['tokens_saved'] || 0)
  const avg = (n: number) => (totalCalls > 0 ? Math.round(n / totalCalls) : 0)

  return c.json({
    projects,
    totalAgents: agents?.['count'] || 0,
    today: { queries: today?.['queries'] || 0, sessions: 0 },
    quality: {
      lastGrade: lastQuality?.['grade'] || '—',
      averageScore: Math.round(Number(avgScore?.['avg']) || 0),
      reportsToday: qualityToday?.['count'] || 0,
    },
    knowledge: {
      totalDocs: kbDocs?.['count'] || 0,
      totalChunks: 0,
      totalHits: kbHits?.['total'] || 0,
    },
    activeKeys: keysCount?.['count'] || 0,
    totalSessions: sessionsCount?.['count'] || 0,
    organizations: orgsCount?.['count'] || 0,
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
