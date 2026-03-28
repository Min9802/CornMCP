import { Hono } from 'hono'
import { dbAll, dbGet, dbRun } from '../db/client.js'
import { generateId } from '@corn/shared-utils'

export const knowledgeRouter = new Hono()

knowledgeRouter.get('/', async (c) => {
  const limit = Number(c.req.query('limit') || '50')
  const projectId = c.req.query('projectId')

  let query = 'SELECT * FROM knowledge_documents'
  const params: unknown[] = []

  if (projectId) {
    query += ' WHERE project_id = ?'
    params.push(projectId)
  }
  query += ' ORDER BY created_at DESC LIMIT ?'
  params.push(limit)

  const docs = await dbAll(query, params)
  return c.json({ documents: docs })
})

knowledgeRouter.post('/', async (c) => {
  const body = await c.req.json()
  const id = body.id || generateId('kb')

  await dbRun(
    `INSERT OR REPLACE INTO knowledge_documents (id, title, source, source_agent_id, project_id, tags, status, content_preview)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
    [
      id,
      body.title,
      body.source || 'manual',
      body.sourceAgentId || null,
      body.projectId || null,
      JSON.stringify(body.tags || []),
      (body.content || '').slice(0, 200),
    ],
  )

  return c.json({ ok: true, id })
})

knowledgeRouter.get('/:id', async (c) => {
  const { id } = c.req.param()
  const doc = await dbGet('SELECT * FROM knowledge_documents WHERE id = ?', [id])
  if (!doc) return c.json({ error: 'Not found' }, 404)

  await dbRun('UPDATE knowledge_documents SET hit_count = hit_count + 1 WHERE id = ?', [id])

  return c.json({ document: doc })
})

knowledgeRouter.delete('/:id', async (c) => {
  const { id } = c.req.param()
  await dbRun('DELETE FROM knowledge_documents WHERE id = ?', [id])
  return c.json({ ok: true })
})
