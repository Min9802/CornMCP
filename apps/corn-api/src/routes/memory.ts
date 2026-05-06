import { Hono } from 'hono'
import { dbAll, dbGet, dbRun } from '../db/client.js'
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

  let query = 'SELECT * FROM agent_memories'
  const params: unknown[] = []
  const conditions: string[] = []

  if (user.role !== 'admin') {
    const ownerConds: string[] = ['user_id = ?']
    params.push(user.id)
    if (projectIds.length > 0) {
      ownerConds.push(`project_id IN (${projectIds.map(() => '?').join(',')})`)
      params.push(...projectIds)
    }
    conditions.push(`(${ownerConds.join(' OR ')})`)
  }

  if (projectId) { conditions.push('project_id = ?'); params.push(projectId) }
  if (branch) { conditions.push('branch = ?'); params.push(branch) }
  if (agentId) { conditions.push('agent_id = ?'); params.push(agentId) }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ')
  }

  query += ' ORDER BY created_at DESC LIMIT ?'
  params.push(limit)

  const memories = await dbAll(query, params)
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

  await dbRun(
    `INSERT OR REPLACE INTO agent_memories
       (id, content, content_preview, agent_id, project_id, branch, tags, user_id, hit_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?,
       COALESCE((SELECT hit_count FROM agent_memories WHERE id = ?), 0),
       COALESCE((SELECT created_at FROM agent_memories WHERE id = ?), datetime('now')))`,
    [
      id,
      content,
      preview,
      body.agentId || null,
      body.projectId || null,
      body.branch || null,
      JSON.stringify(body.tags || []),
      userId,
      id,
      id,
    ],
  )

  return c.json({ ok: true, id })
})

memoryRouter.get('/:id', jwtAuthMiddleware, async (c) => {
  const { id } = c.req.param()
  const { user, projectIds } = getAuthCtx(c)
  const mem = await dbGet('SELECT * FROM agent_memories WHERE id = ?', [id])
  if (!mem) return c.json({ error: 'Not found' }, 404)

  if (user.role !== 'admin') {
    const owned = mem['user_id'] === user.id
      || (mem['project_id'] && projectIds.includes(mem['project_id'] as string))
    if (!owned) return c.json({ error: 'Access denied' }, 403)
  }

  await dbRun('UPDATE agent_memories SET hit_count = hit_count + 1 WHERE id = ?', [id])
  return c.json({ memory: mem })
})

memoryRouter.delete('/:id', jwtAuthMiddleware, async (c) => {
  const { id } = c.req.param()
  const { user } = getAuthCtx(c)

  if (user.role !== 'admin') {
    const mem = await dbGet('SELECT user_id FROM agent_memories WHERE id = ?', [id])
    if (!mem) return c.json({ error: 'Not found' }, 404)
    if (mem['user_id'] !== user.id) return c.json({ error: 'Access denied' }, 403)
  }

  // NOTE: This only deletes the dashboard preview row. The semantic vector
  // entry in MCP's local mem9-vectors.db is NOT removed here — wire that in
  // a follow-up phase if hard delete is required across both stores.
  await dbRun('DELETE FROM agent_memories WHERE id = ?', [id])
  return c.json({ ok: true })
})
