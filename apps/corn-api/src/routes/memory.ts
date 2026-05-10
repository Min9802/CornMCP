import { Hono } from 'hono'
import type { QueryFilter } from 'mongoose'
import { AgentMemory, type AgentMemoryDoc } from '../db/mongoose/index.js'
import { generateId } from '@corn/shared-utils'
import { jwtAuthMiddleware, anyAuthMiddleware, getAuthCtx, getAgentCtx } from '../middleware/auth.js'

// Dashboard preview layer for memories. Real vector data lives in MCP's local
// mem9-vectors.db — this router only stores/returns previews so the web
// dashboard can list/audit/delete entries. Semantic search still goes through
// the corn_memory_search MCP tool.
export const memoryRouter = new Hono()

memoryRouter.get('/', jwtAuthMiddleware, async (c) => {
  const { user, projectIds } = getAuthCtx(c)
  const limit = Number(c.req.query('limit') || '50')
  const projectId = c.req.query('projectId')
  const branch = c.req.query('branch')
  const agentId = c.req.query('agentId')

  const filter: QueryFilter<AgentMemoryDoc> = {}

  if (user.role !== 'admin') {
    // Ownership: own memory OR memory belongs to an accessible project.
    const owners: QueryFilter<AgentMemoryDoc>[] = [{ user_id: user.id }]
    if (projectIds.length > 0) owners.push({ project_id: { $in: projectIds } })
    filter.$or = owners
  }

  if (projectId) filter.project_id = projectId
  if (branch) filter.branch = branch
  if (agentId) filter.agent_id = agentId

  const memories = await AgentMemory.find(filter)
    .sort({ created_at: -1 })
    .limit(limit)
    .lean()

  return c.json({ memories })
})

memoryRouter.post('/', anyAuthMiddleware, async (c) => {
  const body = await c.req.json()
  const authSource = (c as any).get('authSource') as string
  const id = body.id || generateId('mem')

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

  if (!body.content || typeof body.content !== 'string') {
    return c.json({ error: 'content is required' }, 400)
  }

  const content = body.content as string
  const preview = content.slice(0, 200)

  // Mongo equivalent of `INSERT OR REPLACE`: update mutable fields, but
  // preserve `created_at` + `hit_count` from the existing doc via $setOnInsert.
  await AgentMemory.findOneAndUpdate(
    { _id: id },
    {
      $set: {
        content,
        content_preview: preview,
        agent_id: body.agentId || null,
        project_id: body.projectId || null,
        branch: body.branch || null,
        tags: body.tags || [],
        user_id: userId,
      },
      $setOnInsert: { _id: id, hit_count: 0 },
    },
    { upsert: true, setDefaultsOnInsert: true, new: true },
  )

  return c.json({ ok: true, id })
})

memoryRouter.get('/:id', jwtAuthMiddleware, async (c) => {
  const { id } = c.req.param()
  const { user, projectIds } = getAuthCtx(c)
  const mem = await AgentMemory.findById(id).lean()
  if (!mem) return c.json({ error: 'Not found' }, 404)

  if (user.role !== 'admin') {
    const owned = mem.user_id === user.id
      || (mem.project_id && projectIds.includes(mem.project_id))
    if (!owned) return c.json({ error: 'Access denied' }, 403)
  }

  await AgentMemory.updateOne({ _id: id }, { $inc: { hit_count: 1 } })
  return c.json({ memory: mem })
})

memoryRouter.delete('/:id', jwtAuthMiddleware, async (c) => {
  const { id } = c.req.param()
  const { user } = getAuthCtx(c)

  if (user.role !== 'admin') {
    const mem = await AgentMemory.findById(id, { user_id: 1 }).lean()
    if (!mem) return c.json({ error: 'Not found' }, 404)
    if (mem.user_id !== user.id) return c.json({ error: 'Access denied' }, 403)
  }

  // NOTE: This only deletes the dashboard preview row. The semantic vector
  // entry in MCP's local mem9-vectors.db is NOT removed here — wire that in
  // a follow-up phase if hard delete is required across both stores.
  await AgentMemory.deleteOne({ _id: id })
  return c.json({ ok: true })
})
