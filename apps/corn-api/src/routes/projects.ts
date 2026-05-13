// Project + organization CRUD. Mongoose-backed. Ownership enforcement
// continues to use organizations.user_id (a column added by SQLite
// migration 0001 that we've mirrored on the Mongo schema).

import { Hono, type Context } from 'hono'
import { generateId } from '@corn/shared-utils'
import { Project, Organization, User } from '../db/mongoose/index.js'
import { jwtAuthMiddleware, getAuthCtx } from '../middleware/auth.js'

export const projectsRouter = new Hono()

projectsRouter.use('*', jwtAuthMiddleware)

projectsRouter.get('/', async (c) => {
  const { user, projectIds } = getAuthCtx(c)

  let docs: unknown[]
  if (user.role === 'admin') {
    docs = await Project.find({}).sort({ created_at: -1 }).lean()
  } else if (projectIds.length > 0) {
    docs = await Project.find({ _id: { $in: projectIds } })
      .sort({ created_at: -1 })
      .lean()
  } else {
    docs = []
  }

  // Preserve the legacy `id` shape consumed by the dashboard.
  const projects = (docs as Array<Record<string, unknown> & { _id: string }>).map((d) => ({
    ...d,
    id: d._id,
  }))
  return c.json({ projects })
})

projectsRouter.post('/', async (c) => {
  const body = await c.req.json()
  const { user } = getAuthCtx(c)
  const id = generateId('proj')
  const slug = (body.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')

  // Resolve org: explicit body.orgId (verified) OR user's first org.
  // No silent fallback to a shared org — every project must belong to a
  // user-owned organization to prevent cross-tenant leakage.
  let orgId: string
  if (body.orgId) {
    if (user.role !== 'admin') {
      const org = await Organization.findById(body.orgId, { user_id: 1 }).lean()
      if (!org || org.user_id !== user.id) {
        return c.json({ error: 'Organization not found or access denied' }, 403)
      }
    }
    orgId = body.orgId
  } else {
    const firstOrg = await Organization.findOne({ user_id: user.id }, { _id: 1 })
      .sort({ created_at: 1 })
      .lean()
    if (!firstOrg) {
      return c.json(
        {
          error:
            'No organization found. Create an organization first via POST /api/orgs before creating projects.',
        },
        400,
      )
    }
    orgId = firstOrg._id
  }

  await Project.create({
    _id: id,
    org_id: orgId,
    name: body.name,
    slug,
    description: body.description ?? null,
    git_repo_url: body.gitRepoUrl ?? null,
    git_provider: body.gitProvider ?? null,
  } as Parameters<typeof Project.create>[0])

  return c.json({ ok: true, id, orgId })
})

// Check project ownership (non-admin must own the org that owns the project).
async function assertProjectAccess(c: Context, projectId: string) {
  const { user } = getAuthCtx(c)
  const project = await Project.findById(projectId, { org_id: 1 }).lean()
  if (!project) {
    return { ok: false as const, response: c.json({ error: 'Project not found' }, 404) }
  }
  if (user.role !== 'admin') {
    const org = await Organization.findById(project.org_id, { user_id: 1 }).lean()
    if (!org || org.user_id !== user.id) {
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
  await Project.updateOne(
    { _id: id },
    {
      $set: {
        name: body.name,
        slug,
        description: body.description ?? null,
        git_repo_url: body.gitRepoUrl ?? null,
      },
    },
  )

  return c.json({ ok: true })
})

projectsRouter.delete('/:id', async (c) => {
  const { id } = c.req.param()
  const access = await assertProjectAccess(c, id)
  if (!access.ok) return access.response

  // Load the doc so the schema-level cascade middleware fires:
  //   Project.pre('deleteOne', { document: true }) tears down code_*,
  //   index_jobs, change_events, agent_ack, agent_memories,
  //   quality_reports, session_handoffs, knowledge_documents (which in
  //   turn cascades to knowledge_chunks).
  // Wrapped in a transaction inside the middleware itself.
  const project = await Project.findById(id)
  if (!project) return c.json({ error: 'Project not found' }, 404)
  await project.deleteOne()

  return c.json({ ok: true })
})

export const orgsRouter = new Hono()

orgsRouter.use('*', jwtAuthMiddleware)

orgsRouter.get('/', async (c) => {
  const { user } = getAuthCtx(c)

  const filter = user.role === 'admin' ? {} : { user_id: user.id }
  const docs = await Organization.find(filter).sort({ created_at: -1 }).lean()
  const organizations = docs.map((d) => ({ ...d, id: d._id }))
  return c.json({ organizations })
})

// Resolve owner user_id for a new/updated organization.
// Admin can pass an explicit `userId` to assign ownership to any active user.
// Non-admin (or admin omitting the field) defaults to the current user.
// Returns either { ok: true, userId } or { ok: false, response }.
async function resolveOrgOwner(
  c: Context,
  bodyUserId: unknown,
  fallbackUserId: string,
): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  const { user } = getAuthCtx(c)
  const raw = typeof bodyUserId === 'string' ? bodyUserId.trim() : ''

  // Non-admin can never reassign — always self.
  if (user.role !== 'admin') return { ok: true, userId: fallbackUserId }

  // Empty / not provided → default to fallback (current admin on create,
  // existing owner on update).
  if (!raw) return { ok: true, userId: fallbackUserId }

  const target = await User.findById(raw, { _id: 1, is_active: 1 }).lean()
  if (!target) {
    return { ok: false, response: c.json({ error: 'Assigned user not found' }, 400) }
  }
  if (target.is_active === false) {
    return { ok: false, response: c.json({ error: 'Assigned user is inactive' }, 400) }
  }
  return { ok: true, userId: raw }
}

orgsRouter.post('/', async (c) => {
  const body = await c.req.json()
  const { user } = getAuthCtx(c)
  const id = generateId('org')
  const slug = (body.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')

  const owner = await resolveOrgOwner(c, body.userId, user.id)
  if (!owner.ok) return owner.response

  await Organization.create({
    _id: id,
    name: body.name,
    slug,
    description: body.description ?? null,
    user_id: owner.userId,
  } as Parameters<typeof Organization.create>[0])

  return c.json({ ok: true, id, userId: owner.userId })
})

orgsRouter.put('/:id', async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json()
  const { user } = getAuthCtx(c)

  const existing = await Organization.findById(id, { user_id: 1 }).lean()
  if (!existing) return c.json({ error: 'Organization not found' }, 404)

  // Non-admin must own the org.
  if (user.role !== 'admin' && existing.user_id !== user.id) {
    return c.json({ error: 'Access denied' }, 403)
  }

  const slug = (body.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const update: Record<string, unknown> = {
    name: body.name,
    slug,
    description: body.description ?? null,
  }

  // Owner reassignment — only honored when the client sends the field
  // explicitly. Admin can set any active user; admin sending empty string
  // ("yourself" option in the UI) resets ownership to themselves. Non-admin
  // requests silently keep the existing owner.
  if (body.userId !== undefined) {
    const fallback = user.role === 'admin' ? user.id : existing.user_id ?? user.id
    const owner = await resolveOrgOwner(c, body.userId, fallback)
    if (!owner.ok) return owner.response
    update.user_id = owner.userId
  }

  await Organization.updateOne({ _id: id }, { $set: update })
  return c.json({ ok: true })
})

orgsRouter.delete('/:id', async (c) => {
  const { id } = c.req.param()
  const { user } = getAuthCtx(c)

  // Check ownership
  if (user.role !== 'admin') {
    const org = await Organization.findById(id, { user_id: 1 }).lean()
    if (!org || org.user_id !== user.id) {
      return c.json({ error: 'Access denied' }, 403)
    }
  }

  await Organization.deleteOne({ _id: id })
  return c.json({ ok: true })
})
