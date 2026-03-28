import { Hono } from 'hono'
import { dbAll, dbRun } from '../db/client.js'

export const sessionsRouter = new Hono()

sessionsRouter.get('/', async (c) => {
  const limit = Number(c.req.query('limit') || '50')
  const sessions = await dbAll(
    'SELECT * FROM session_handoffs ORDER BY created_at DESC LIMIT ?',
    [limit],
  )
  return c.json({ sessions })
})

sessionsRouter.post('/', async (c) => {
  const body = await c.req.json()

  await dbRun(
    `INSERT INTO session_handoffs (id, from_agent, project, task_summary, context, status, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      body.id,
      body.agentId || 'unknown',
      body.project,
      body.taskSummary,
      JSON.stringify({ branch: body.branch }),
      body.status || 'active',
      body.projectId || null,
    ],
  )

  return c.json({ ok: true, id: body.id })
})

sessionsRouter.patch('/:id', async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json()

  const context = JSON.stringify({
    summary: body.summary,
    filesChanged: body.filesChanged,
    decisions: body.decisions,
    blockers: body.blockers,
  })

  await dbRun(
    `UPDATE session_handoffs SET status = ?, context = ? WHERE id = ?`,
    [body.status || 'completed', context, id],
  )

  return c.json({ ok: true })
})
