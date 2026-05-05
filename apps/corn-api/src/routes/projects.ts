import { Hono } from 'hono'
import { dbAll, dbGet, dbRun } from '../db/client.js'
import { generateId } from '@corn/shared-utils'
import { jwtAuthMiddleware, getAuthCtx } from '../middleware/auth.js'

export const projectsRouter = new Hono()

projectsRouter.use('*', jwtAuthMiddleware)

projectsRouter.get('/', async (c) => {
  const { user, projectIds } = getAuthCtx(c)

  const projects = user.role === 'admin'
    ? await dbAll('SELECT * FROM projects ORDER BY created_at DESC')
    : projectIds.length > 0
    ? await dbAll(
        `SELECT * FROM projects WHERE id IN (${projectIds.map(() => '?').join(',')}) ORDER BY created_at DESC`,
        projectIds,
      )
    : []

  return c.json({ projects })
})

projectsRouter.post('/', async (c) => {
  const body = await c.req.json()
  const { user } = getAuthCtx(c)
  const id = generateId('proj')
  const slug = (body.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')

  // Verify org belongs to user (non-admin)
  if (user.role !== 'admin' && body.orgId) {
    const org = await dbGet('SELECT user_id FROM organizations WHERE id = ?', [body.orgId])
    if (!org || org['user_id'] !== user.id) {
      return c.json({ error: 'Organization not found or access denied' }, 403)
    }
  }

  await dbRun(
    `INSERT INTO projects (id, org_id, name, slug, description, git_repo_url, git_provider)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      body.orgId || 'org-default',
      body.name,
      slug,
      body.description || null,
      body.gitRepoUrl || null,
      body.gitProvider || null,
    ],
  )

  return c.json({ ok: true, id })
})

// Check project ownership (non-admin must own the org that owns the project)
async function assertProjectAccess(c: any, projectId: string) {
  const { user } = getAuthCtx(c)
  const project = await dbGet('SELECT org_id FROM projects WHERE id = ?', [projectId])
  if (!project) {
    return { ok: false as const, response: c.json({ error: 'Project not found' }, 404) }
  }
  if (user.role !== 'admin') {
    const org = await dbGet('SELECT user_id FROM organizations WHERE id = ?', [project['org_id']])
    if (!org || org['user_id'] !== user.id) {
      return { ok: false as const, response: c.json({ error: 'Access denied' }, 403) }
    }
  }
  return { ok: true as const }
}

projectsRouter.put('/:id', async (c) => {
  const { id } = c.req.param()
  const access = await assertProjectAccess(c, id)
  if (!access.ok) return access.response

  const body = await c.req.json()
  if (!body.name || !String(body.name).trim()) {
    return c.json({ error: 'Name is required' }, 400)
  }

  const slug = String(body.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')
  await dbRun(
    `UPDATE projects
     SET name = ?, slug = ?, description = ?, git_repo_url = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [body.name, slug, body.description || null, body.gitRepoUrl || null, id],
  )

  return c.json({ ok: true })
})

projectsRouter.delete('/:id', async (c) => {
  const { id } = c.req.param()
  const access = await assertProjectAccess(c, id)
  if (!access.ok) return access.response

  // Manual cascade: PRAGMA foreign_keys is OFF in sql.js, so CASCADE rules
  // declared in schema won't fire. Clean up hard-dependent rows explicitly.
  // Nullable/historical refs (usage_logs, query_logs, quality_reports,
  // knowledge_documents, api_keys, agent_queue) are intentionally kept for audit.
  await dbRun('DELETE FROM code_edges WHERE project_id = ?', [id])
  await dbRun('DELETE FROM code_symbols WHERE project_id = ?', [id])
  await dbRun('DELETE FROM index_jobs WHERE project_id = ?', [id])
  await dbRun('DELETE FROM change_events WHERE project_id = ?', [id])
  await dbRun('DELETE FROM agent_ack WHERE project_id = ?', [id])
  await dbRun('DELETE FROM projects WHERE id = ?', [id])
  return c.json({ ok: true })
})

export const orgsRouter = new Hono()

orgsRouter.use('*', jwtAuthMiddleware)

orgsRouter.get('/', async (c) => {
  const { user } = getAuthCtx(c)

  const orgs = user.role === 'admin'
    ? await dbAll('SELECT * FROM organizations ORDER BY created_at DESC')
    : await dbAll(
        'SELECT * FROM organizations WHERE user_id = ? ORDER BY created_at DESC',
        [user.id],
      )

  return c.json({ organizations: orgs })
})

orgsRouter.post('/', async (c) => {
  const body = await c.req.json()
  const { user } = getAuthCtx(c)
  const id = generateId('org')
  const slug = (body.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')

  await dbRun(
    `INSERT INTO organizations (id, name, slug, description, user_id) VALUES (?, ?, ?, ?, ?)`,
    [id, body.name, slug, body.description || null, user.id],
  )

  return c.json({ ok: true, id })
})

orgsRouter.put('/:id', async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json()
  const { user } = getAuthCtx(c)

  // Check ownership
  if (user.role !== 'admin') {
    const org = await dbGet('SELECT user_id FROM organizations WHERE id = ?', [id])
    if (!org || org['user_id'] !== user.id) {
      return c.json({ error: 'Access denied' }, 403)
    }
  }

  const slug = (body.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  await dbRun(
    'UPDATE organizations SET name = ?, slug = ?, description = ? WHERE id = ?',
    [body.name, slug, body.description || null, id],
  )

  return c.json({ ok: true })
})

orgsRouter.delete('/:id', async (c) => {
  const { id } = c.req.param()
  const { user } = getAuthCtx(c)

  // Check ownership
  if (user.role !== 'admin') {
    const org = await dbGet('SELECT user_id FROM organizations WHERE id = ?', [id])
    if (!org || org['user_id'] !== user.id) {
      return c.json({ error: 'Access denied' }, 403)
    }
  }

  await dbRun('DELETE FROM organizations WHERE id = ?', [id])
  return c.json({ ok: true })
})
