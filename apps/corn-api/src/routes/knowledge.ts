import { Hono } from 'hono'
import { dbAll, dbGet, dbRun } from '../db/client.js'
import { generateId } from '@corn/shared-utils'
import { jwtAuthMiddleware, anyAuthMiddleware, getAuthCtx, getAgentCtx } from '../middleware/auth.js'

export const knowledgeRouter = new Hono()

knowledgeRouter.get('/', jwtAuthMiddleware, async (c) => {
  const { user, projectIds } = getAuthCtx(c)
  const limit = Number(c.req.query('limit') || '50')
  const projectId = c.req.query('projectId')

  let query = 'SELECT * FROM knowledge_documents'
  const params: unknown[] = []

  if (user.role !== 'admin') {
    const conditions: string[] = ['user_id = ?']
    params.push(user.id)
    if (projectIds.length > 0) {
      conditions.push(`project_id IN (${projectIds.map(() => '?').join(',')})`)
      params.push(...projectIds)
    }
    query += ` WHERE (${conditions.join(' OR ')})`
    if (projectId) { query += ' AND project_id = ?'; params.push(projectId) }
  } else if (projectId) {
    query += ' WHERE project_id = ?'
    params.push(projectId)
  }

  query += ' ORDER BY created_at DESC LIMIT ?'
  params.push(limit)

  const docs = await dbAll(query, params)
  return c.json({ documents: docs })
})

knowledgeRouter.post('/', anyAuthMiddleware, async (c) => {
  const body = await c.req.json()
  const authSource = (c as any).get('authSource') as string
  const id = body.id || generateId('kb')

  let userId: string | null = null
  if (authSource === 'jwt') {
    const { user } = getAuthCtx(c)
    userId = user.id
  } else {
    const { agentUserId, agentUserProjectIds } = getAgentCtx(c)
    userId = agentUserId
    if (body.projectId && agentUserProjectIds.length > 0 && !agentUserProjectIds.includes(body.projectId)) {
      return c.json({ error: 'Access denied: project does not belong to this API key owner' }, 403)
    }
  }

  await dbRun(
    `INSERT OR REPLACE INTO knowledge_documents (id, title, source, source_agent_id, project_id, tags, status, content_preview, user_id)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [
      id,
      body.title,
      body.source || 'manual',
      body.sourceAgentId || null,
      body.projectId || null,
      JSON.stringify(body.tags || []),
      (body.content || '').slice(0, 200),
      userId,
    ],
  )

  return c.json({ ok: true, id })
})

knowledgeRouter.get('/:id', jwtAuthMiddleware, async (c) => {
  const { id } = c.req.param()
  const { user, projectIds } = getAuthCtx(c)
  const doc = await dbGet('SELECT * FROM knowledge_documents WHERE id = ?', [id])
  if (!doc) return c.json({ error: 'Not found' }, 404)

  // Access check for non-admin
  if (user.role !== 'admin') {
    const owned = doc['user_id'] === user.id || (doc['project_id'] && projectIds.includes(doc['project_id'] as string))
    if (!owned) return c.json({ error: 'Access denied' }, 403)
  }

  await dbRun('UPDATE knowledge_documents SET hit_count = hit_count + 1 WHERE id = ?', [id])
  return c.json({ document: doc })
})

knowledgeRouter.delete('/:id', jwtAuthMiddleware, async (c) => {
  const { id } = c.req.param()
  const { user } = getAuthCtx(c)

  if (user.role !== 'admin') {
    const doc = await dbGet('SELECT user_id FROM knowledge_documents WHERE id = ?', [id])
    if (!doc) return c.json({ error: 'Not found' }, 404)
    if (doc['user_id'] !== user.id) return c.json({ error: 'Access denied' }, 403)
  }

  await dbRun('DELETE FROM knowledge_documents WHERE id = ?', [id])
  return c.json({ ok: true })
})

