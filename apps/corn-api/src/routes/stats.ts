import { Hono } from 'hono'
import { dbAll, dbGet, dbRun } from '../db/client.js'
import { apiKeyAuthMiddleware, jwtAuthMiddleware, getAuthCtx, getAgentCtx } from '../middleware/auth.js'

export const metricsRouter = new Hono()

// ─── Log a query (called by MCP server / API key) ────────
metricsRouter.post('/query-log', apiKeyAuthMiddleware, async (c) => {
  const body = await c.req.json()
  const { agentKeyId } = getAgentCtx(c)

  await dbRun(
    `INSERT INTO query_logs (agent_id, tool, params, latency_ms, status, error, project_id, input_size, output_size, compute_tokens, compute_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      agentKeyId || body.agentId || 'unknown',
      body.tool || 'unknown',
      body.params ? JSON.stringify(body.params) : null,
      body.latencyMs || 0,
      body.status || 'ok',
      body.error || null,
      body.projectId || null,
      body.inputSize || 0,
      body.outputSize || 0,
      body.computeTokens || 0,
      body.computeModel || null,
    ],
  )

  return c.json({ ok: true })
})

// ─── Get activity feed (JWT) ─────────────────────────────
metricsRouter.get('/activity', jwtAuthMiddleware, async (c) => {
  const { user, keyIds } = getAuthCtx(c)
  const limit = Number(c.req.query('limit') || '20')

  const keyFilter = user.role !== 'admin' && keyIds.length > 0
    ? `AND agent_id IN (${keyIds.map(() => '?').join(',')})`
    : ''
  const keyParams = user.role !== 'admin' ? keyIds : []

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

  const kf = !isAdmin && keyIds.length > 0
    ? `AND agent_id IN (${keyIds.map(() => '?').join(',')})` : ''
  const kp = !isAdmin ? keyIds : []
  const pf = !isAdmin && projectIds.length > 0
    ? `AND id IN (${projectIds.map(() => '?').join(',')})` : ''
  const pp = !isAdmin ? projectIds : []

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

  const qpf = !isAdmin && projectIds.length > 0
    ? `AND project_id IN (${projectIds.map(() => '?').join(',')})` : ''
  const qpp = !isAdmin ? projectIds : []

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
  const toolCalls = await dbGet(
    `SELECT COUNT(*) as count, COALESCE(SUM(compute_tokens), 0) as tokens FROM query_logs WHERE 1=1 ${kf}`,
    kp,
  )

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
      totalTokensSaved: toolCalls?.['tokens'] || 0,
      totalToolCalls: toolCalls?.['count'] || 0,
      avgTokensPerCall:
        Number(toolCalls?.['count']) > 0
          ? Math.round(Number(toolCalls?.['tokens'] || 0) / Number(toolCalls?.['count']))
          : 0,
      topTools: [],
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
