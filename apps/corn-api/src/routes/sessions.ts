import { Hono } from 'hono'
import { dbAll, dbGet, dbRun } from '../db/client.js'
import { generateId } from '@corn/shared-utils'
import { jwtAuthMiddleware, apiKeyAuthMiddleware, getAuthCtx, getAgentCtx } from '../middleware/auth.js'

export const sessionsRouter = new Hono()

// GET — dashboard (JWT)
sessionsRouter.get('/', jwtAuthMiddleware, async (c) => {
  const { user, keyIds } = getAuthCtx(c)
  const limit = Number(c.req.query('limit') || '50')

  const sessions = user.role === 'admin'
    ? await dbAll('SELECT * FROM session_handoffs ORDER BY created_at DESC LIMIT ?', [limit])
    : keyIds.length > 0
    ? await dbAll(
        `SELECT * FROM session_handoffs WHERE from_agent IN (${keyIds.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT ?`,
        [...keyIds, limit],
      )
    : []

  return c.json({ sessions })
})

/**
 * Auto-upsert org + project by name.
 * If project doesn't exist, create it (and its org) for the API key owner.
 * Returns the project ID.
 */
async function ensureProject(projectName: string, userId: string): Promise<string> {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-')

  // Check if project exists by slug (for this user or globally)
  let project = await dbGet(
    `SELECT p.id FROM projects p
     JOIN organizations o ON p.org_id = o.id
     WHERE p.slug = ? AND (o.user_id = ? OR o.user_id IS NULL)
     LIMIT 1`,
    [slug, userId],
  )
  if (project) return project['id'] as string

  // Also try matching by name
  project = await dbGet(
    `SELECT p.id FROM projects p
     JOIN organizations o ON p.org_id = o.id
     WHERE p.name = ? AND (o.user_id = ? OR o.user_id IS NULL)
     LIMIT 1`,
    [projectName, userId],
  )
  if (project) return project['id'] as string

  // Ensure a default org for this user
  let org = await dbGet(
    'SELECT id FROM organizations WHERE user_id = ? ORDER BY created_at ASC LIMIT 1',
    [userId],
  )
  if (!org) {
    const orgId = generateId('org')
    await dbRun(
      'INSERT INTO organizations (id, name, slug, description, user_id) VALUES (?, ?, ?, ?, ?)',
      [orgId, 'My Workspace', 'my-workspace', 'Auto-created default organization', userId],
    )
    org = { id: orgId }
  }

  // Create project
  const projId = generateId('proj')
  await dbRun(
    `INSERT INTO projects (id, org_id, name, slug, description) VALUES (?, ?, ?, ?, ?)`,
    [projId, org['id'], projectName, slug, `Auto-created from agent session`],
  )

  return projId
}

// POST — agent write (API key)
sessionsRouter.post('/', apiKeyAuthMiddleware, async (c) => {
  const body = await c.req.json()
  const { agentKeyId, agentUserId } = getAgentCtx(c)

  // Auto-create project if name provided but no projectId
  let projectId = body.projectId || null
  if (!projectId && body.project && agentUserId) {
    projectId = await ensureProject(body.project, agentUserId)
  }

  await dbRun(
    `INSERT INTO session_handoffs (id, from_agent, project, task_summary, context, status, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      body.id,
      agentKeyId || body.agentId || 'unknown',
      body.project,
      body.taskSummary,
      JSON.stringify({ branch: body.branch }),
      body.status || 'active',
      projectId,
    ],
  )

  return c.json({ ok: true, id: body.id, projectId })
})

// PATCH — agent update (API key)
sessionsRouter.patch('/:id', apiKeyAuthMiddleware, async (c) => {
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
