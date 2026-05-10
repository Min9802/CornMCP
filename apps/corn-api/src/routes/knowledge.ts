import { Hono } from 'hono'
import type { QueryFilter } from 'mongoose'
import { KnowledgeDocument, type KnowledgeDocumentDoc } from '../db/mongoose/index.js'
import { generateId } from '@corn/shared-utils'
import { jwtAuthMiddleware, anyAuthMiddleware, getAuthCtx, getAgentCtx } from '../middleware/auth.js'

export const knowledgeRouter = new Hono()

knowledgeRouter.get('/', jwtAuthMiddleware, async (c) => {
  const { user, projectIds } = getAuthCtx(c)
  const limit = Number(c.req.query('limit') || '50')
  const projectId = c.req.query('projectId')

  const filter: QueryFilter<KnowledgeDocumentDoc> = {}

  if (user.role !== 'admin') {
    // Ownership: own document OR document belongs to an accessible project.
    const owners: QueryFilter<KnowledgeDocumentDoc>[] = [{ user_id: user.id }]
    if (projectIds.length > 0) owners.push({ project_id: { $in: projectIds } })
    filter.$or = owners
  }

  if (projectId) filter.project_id = projectId

  const documents = await KnowledgeDocument.find(filter)
    .sort({ created_at: -1 })
    .limit(limit)
    .lean()

  return c.json({ documents })
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

  // Mongo equivalent of `INSERT OR REPLACE`: keep created_at + hit_count + chunk_count
  // intact across upserts.
  await KnowledgeDocument.findOneAndUpdate(
    { _id: id },
    {
      $set: {
        title: body.title,
        source: body.source || 'manual',
        source_agent_id: body.sourceAgentId || null,
        project_id: body.projectId || null,
        tags: body.tags || [],
        status: 'active',
        content_preview: (body.content || '').slice(0, 200),
        user_id: userId,
      },
      $setOnInsert: { _id: id, hit_count: 0, chunk_count: 0 },
    },
    { upsert: true, setDefaultsOnInsert: true, new: true },
  )

  return c.json({ ok: true, id })
})

knowledgeRouter.get('/:id', jwtAuthMiddleware, async (c) => {
  const { id } = c.req.param()
  const { user, projectIds } = getAuthCtx(c)
  const document = await KnowledgeDocument.findById(id).lean()
  if (!document) return c.json({ error: 'Not found' }, 404)

  // Access check for non-admin
  if (user.role !== 'admin') {
    const owned = document.user_id === user.id
      || (document.project_id && projectIds.includes(document.project_id))
    if (!owned) return c.json({ error: 'Access denied' }, 403)
  }

  await KnowledgeDocument.updateOne({ _id: id }, { $inc: { hit_count: 1 } })
  return c.json({ document })
})

knowledgeRouter.delete('/:id', jwtAuthMiddleware, async (c) => {
  const { id } = c.req.param()
  const { user } = getAuthCtx(c)

  // Load the document instance so the schema's pre('deleteOne') middleware
  // (which cascades to KnowledgeChunk) can fire.
  const doc = await KnowledgeDocument.findById(id)
  if (!doc) return c.json({ error: 'Not found' }, 404)

  if (user.role !== 'admin' && doc.user_id !== user.id) {
    return c.json({ error: 'Access denied' }, 403)
  }

  await doc.deleteOne()
  return c.json({ ok: true })
})

