import { Hono } from 'hono'
import { dbAll, dbGet, dbRun } from '../db/client.js'

export const qualityRouter = new Hono()

qualityRouter.get('/', async (c) => {
  const limit = Number(c.req.query('limit') || '50')
  const reports = await dbAll(
    'SELECT * FROM quality_reports ORDER BY created_at DESC LIMIT ?',
    [limit],
  )
  return c.json({ reports })
})

qualityRouter.post('/', async (c) => {
  const body = await c.req.json()

  await dbRun(
    `INSERT INTO quality_reports (id, project_id, agent_id, session_id, gate_name, score_build, score_regression, score_standards, score_traceability, score_total, grade, passed, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ],
  )

  return c.json({ ok: true, id: body.id })
})

qualityRouter.get('/trends', async (c) => {
  const trends = await dbAll(
    `SELECT date(created_at) as date, AVG(score_total) as avg_score, COUNT(*) as count
     FROM quality_reports
     GROUP BY date(created_at)
     ORDER BY date DESC LIMIT 30`,
  )
  return c.json({ trends })
})
