import { Hono } from 'hono'
import { dbAll, dbGet, dbRun } from '../db/client.js'
import { jwtAuthMiddleware, anyAuthMiddleware, getAuthCtx, getAgentCtx } from '../middleware/auth.js'

export const qualityRouter = new Hono()

qualityRouter.get('/', jwtAuthMiddleware, async (c) => {
  const { user, projectIds } = getAuthCtx(c)
  const limit = Number(c.req.query('limit') || '50')

  const reports = user.role === 'admin'
    ? await dbAll('SELECT * FROM quality_reports ORDER BY created_at DESC LIMIT ?', [limit])
    : projectIds.length > 0
    ? await dbAll(
        `SELECT * FROM quality_reports WHERE project_id IN (${projectIds.map(() => '?').join(',')}) OR user_id = ? ORDER BY created_at DESC LIMIT ?`,
        [...projectIds, user.id, limit],
      )
    : await dbAll(
        'SELECT * FROM quality_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
        [user.id, limit],
      )

  return c.json({ reports })
})

qualityRouter.post('/', anyAuthMiddleware, async (c) => {
  const body = await c.req.json()
  const authSource = (c as any).get('authSource') as string

  let userId: string | null = null
  if (authSource === 'jwt') {
    const { user } = getAuthCtx(c)
    userId = user.id
    const { projectIds } = getAuthCtx(c)
    if (body.projectId && !projectIds.includes(body.projectId) && user.role !== 'admin') {
      return c.json({ error: 'Access denied: project not found' }, 403)
    }
  } else {
    const { agentUserId, agentUserProjectIds } = getAgentCtx(c)
    userId = agentUserId
    if (body.projectId && agentUserProjectIds.length > 0 && !agentUserProjectIds.includes(body.projectId)) {
      return c.json({ error: 'Access denied: project does not belong to this API key owner' }, 403)
    }
  }

  await dbRun(
    `INSERT INTO quality_reports (id, project_id, agent_id, session_id, gate_name, score_build, score_regression, score_standards, score_traceability, score_total, grade, passed, details, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      body.id,
      body.projectId || null,
      body.agentId,
      body.sessionId || null,
      body.gateName,
      body.scoreBuild,
      body.scoreRegression,
      body.scoreStandards,
      body.scoreTraceability,
      body.scoreTotal,
      body.grade,
      body.passed ? 1 : 0,
      body.details ? JSON.stringify(body.details) : null,
      userId,
    ],
  )

  return c.json({ ok: true, id: body.id })
})

qualityRouter.get('/trends', jwtAuthMiddleware, async (c) => {
  const { user, projectIds } = getAuthCtx(c)

  const whereClause = user.role === 'admin'
    ? ''
    : projectIds.length > 0
    ? `WHERE project_id IN (${projectIds.map(() => '?').join(',')}) OR user_id = '${user.id}'`
    : `WHERE user_id = '${user.id}'`

  const trends = await dbAll(
    `SELECT date(created_at) as date, AVG(score_total) as avg_score, COUNT(*) as count
     FROM quality_reports ${whereClause}
     GROUP BY date(created_at)
     ORDER BY date DESC LIMIT 30`,
    user.role !== 'admin' && projectIds.length > 0 ? projectIds : [],
  )
  return c.json({ trends })
})

