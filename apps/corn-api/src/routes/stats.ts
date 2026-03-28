import { Hono } from 'hono'
import { dbAll, dbGet, dbRun } from '../db/client.js'

export const metricsRouter = new Hono()

// ─── Log a query (called by MCP server) ─────────────────
metricsRouter.post('/query-log', async (c) => {
  const body = await c.req.json()

  await dbRun(
    `INSERT INTO query_logs (agent_id, tool, params, latency_ms, status, error, project_id, input_size, output_size, compute_tokens, compute_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      body.agentId || 'unknown',
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

// ─── Get activity feed ──────────────────────────────────
metricsRouter.get('/activity', async (c) => {
  const limit = Number(c.req.query('limit') || '20')

  const rows = await dbAll(
    `SELECT id, agent_id, tool, status, latency_ms, created_at
     FROM query_logs ORDER BY created_at DESC LIMIT ?`,
    [limit],
  )

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

// ─── Dashboard overview ─────────────────────────────────
metricsRouter.get('/overview', async (c) => {
  const projects = await dbAll('SELECT * FROM projects')

  const today = await dbGet(
    `SELECT COUNT(*) as queries FROM query_logs
     WHERE created_at >= datetime('now', 'start of day')`,
  )

  const agents = await dbGet(
    `SELECT COUNT(DISTINCT agent_id) as count FROM query_logs
     WHERE created_at >= datetime('now', '-7 days')`,
  )

  const lastQuality = await dbGet(
    'SELECT grade, score_total FROM quality_reports ORDER BY created_at DESC LIMIT 1',
  )

  const avgScore = await dbGet('SELECT AVG(score_total) as avg FROM quality_reports')

  const qualityToday = await dbGet(
    `SELECT COUNT(*) as count FROM quality_reports
     WHERE created_at >= datetime('now', 'start of day')`,
  )

  const kbDocs = await dbGet('SELECT COUNT(*) as count FROM knowledge_documents')
  const kbHits = await dbGet('SELECT COALESCE(SUM(hit_count), 0) as total FROM knowledge_documents')
  const keysCount = await dbGet('SELECT COUNT(*) as count FROM api_keys')
  const sessionsCount = await dbGet('SELECT COUNT(*) as count FROM session_handoffs')
  const orgsCount = await dbGet('SELECT COUNT(*) as count FROM organizations')

  const toolCalls = await dbGet(
    'SELECT COUNT(*) as count, COALESCE(SUM(compute_tokens), 0) as tokens FROM query_logs',
  )

  return c.json({
    projects,
    totalAgents: agents?.count || 0,
    today: { queries: today?.queries || 0, sessions: 0 },
    quality: {
      lastGrade: lastQuality?.grade || '—',
      averageScore: Math.round(Number(avgScore?.avg) || 0),
      reportsToday: qualityToday?.count || 0,
    },
    knowledge: {
      totalDocs: kbDocs?.count || 0,
      totalChunks: 0,
      totalHits: kbHits?.total || 0,
    },
    activeKeys: keysCount?.count || 0,
    totalSessions: sessionsCount?.count || 0,
    organizations: orgsCount?.count || 0,
    uptime: Math.floor(process.uptime()),
    tokenSavings: {
      totalTokensSaved: toolCalls?.tokens || 0,
      totalToolCalls: toolCalls?.count || 0,
      avgTokensPerCall:
        Number(toolCalls?.count) > 0
          ? Math.round(Number(toolCalls?.tokens || 0) / Number(toolCalls?.count))
          : 0,
      topTools: [],
    },
  })
})

// ─── Hints engine ───────────────────────────────────────
metricsRouter.get('/hints/:agentId', async (c) => {
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
