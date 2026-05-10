// Session handoff routes. Mongoose-backed. The fuzzy project matching
// helpers used to lean on SQL string functions (LOWER, REPLACE) — we
// reproduce them with case-insensitive regex + a small JS post-filter.
//
// Ownership scope: a project is "in scope" if its org belongs to the
// user OR has a null user_id (legacy global org seeded as `org-default`).

import { Hono } from 'hono'
import { generateId } from '@corn/shared-utils'
import { Organization, Project, SessionHandoff } from '../db/mongoose/index.js'
import {
  jwtAuthMiddleware,
  apiKeyAuthMiddleware,
  getAuthCtx,
  getAgentCtx,
} from '../middleware/auth.js'

export const sessionsRouter = new Hono()

// GET — dashboard (JWT)
sessionsRouter.get('/', jwtAuthMiddleware, async (c) => {
  const { user, keyIds } = getAuthCtx(c)
  const limit = Math.max(1, Math.min(500, Number(c.req.query('limit') || '50')))

  let docs: Array<Record<string, unknown> & { _id: string }>
  if (user.role === 'admin') {
    docs = await SessionHandoff.find({}).sort({ created_at: -1 }).limit(limit).lean() as never
  } else if (keyIds.length > 0) {
    docs = await SessionHandoff.find({ from_agent: { $in: keyIds } })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean() as never
  } else {
    docs = []
  }

  // Preserve the legacy `id` field consumed by the dashboard.
  const sessions = docs.map((d) => ({ ...d, id: d._id }))
  return c.json({ sessions })
})

/**
 * Build common variants of a git remote URL so SSH/HTTPS forms and the
 * trailing `.git` suffix all collapse to the same project. Examples for
 * `git@github.com:Min9802/CornMCP.git`:
 *   git@github.com:Min9802/CornMCP.git
 *   git@github.com:Min9802/CornMCP
 *   https://github.com/Min9802/CornMCP
 *   https://github.com/Min9802/CornMCP.git
 */
function gitUrlVariants(url: string): string[] {
  const trimmed = url.trim()
  if (!trimmed) return []
  const variants = new Set<string>([trimmed])
  variants.add(trimmed.replace(/\.git$/, ''))

  const sshMatch = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
  if (sshMatch) {
    variants.add(`https://${sshMatch[1]}/${sshMatch[2]}`)
    variants.add(`https://${sshMatch[1]}/${sshMatch[2]}.git`)
  }
  const httpsMatch = trimmed.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (httpsMatch) {
    variants.add(`git@${httpsMatch[1]}:${httpsMatch[2]}`)
    variants.add(`git@${httpsMatch[1]}:${httpsMatch[2]}.git`)
  }
  return [...variants]
}

/** Normalize an absolute path for case-insensitive comparison (Windows-aware). */
function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Org IDs the user can see (their own + the legacy global null-owner orgs). */
async function ownedOrgIds(userId: string): Promise<string[]> {
  const orgs = await Organization.find(
    { $or: [{ user_id: userId }, { user_id: null }] },
    { _id: 1 },
  ).lean()
  return orgs.map((o) => o._id)
}

/** Escape regex metacharacters when interpolating user-supplied strings. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function findProjectByGitUrl(userId: string, gitRepoUrl: string): Promise<string | null> {
  const orgIds = await ownedOrgIds(userId)
  if (orgIds.length === 0) return null

  for (const variant of gitUrlVariants(gitRepoUrl)) {
    // Case-insensitive exact match (anchored regex). Replaces SQL `LOWER(p.git_repo_url) = LOWER(?)`.
    const found = await Project.findOne(
      {
        org_id: { $in: orgIds },
        git_repo_url: { $regex: `^${escapeRegex(variant)}$`, $options: 'i' },
      },
      { _id: 1 },
    ).lean()
    if (found) return found._id
  }
  return null
}

async function findProjectByLocalPath(userId: string, localPath: string): Promise<string | null> {
  const norm = normalizePath(localPath)
  if (!norm) return null

  const orgIds = await ownedOrgIds(userId)
  if (orgIds.length === 0) return null

  // Pull every candidate then normalize+compare in JS — same shape as the
  // legacy implementation, which couldn't push the path normalization down
  // into SQL anyway.
  const projects = await Project.find(
    { org_id: { $in: orgIds }, git_repo_url: { $ne: null } },
    { _id: 1, git_repo_url: 1 },
  ).lean()
  for (const p of projects) {
    if (p.git_repo_url && normalizePath(p.git_repo_url) === norm) return p._id
  }
  return null
}

async function findProjectByFuzzyName(userId: string, projectName: string): Promise<string | null> {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const fuzzy = projectName.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!fuzzy) return null

  const orgIds = await ownedOrgIds(userId)
  if (orgIds.length === 0) return null

  // Slug exact match first (fast, indexable).
  const exact = await Project.findOne(
    { org_id: { $in: orgIds }, slug },
    { _id: 1 },
  ).lean()
  if (exact) return exact._id

  // Fuzzy: walk projects in scope and compare normalized strings in JS.
  // Cardinality per user stays small (single-digit orgs * 10s of projects).
  const projects = await Project.find(
    { org_id: { $in: orgIds } },
    { _id: 1, slug: 1, name: 1 },
  ).lean()
  for (const p of projects) {
    const slugNorm = String(p.slug ?? '').toLowerCase().replace(/[-_]/g, '')
    const nameNorm = String(p.name ?? '').toLowerCase().replace(/[-_]/g, '')
    if (slugNorm === fuzzy || nameNorm === fuzzy) return p._id
  }
  return null
}

/**
 * Auto-upsert org + project by name with multi-signal matching.
 *
 * Match priority (first hit wins):
 *   1. `gitRepoUrl` hint — normalized SSH/HTTPS variants matched against `projects.git_repo_url`
 *   2. `localPath` hint — normalized path matched against `projects.git_repo_url` (dual-purpose field)
 *   3. Project name — exact slug, then fuzzy comparison ignoring dashes/underscores
 *
 * If nothing matches, creates a new project (and default org if needed) for the
 * API key owner. The hint is persisted into `git_repo_url` so subsequent calls
 * resolve back to the same row — preventing the duplicate-project bug where
 * `corn-mcp` (created via UI) and `CornMCP` (created via agent) both exist.
 */
async function ensureProject(
  projectName: string,
  userId: string,
  hints?: { gitRepoUrl?: string; localPath?: string },
): Promise<string> {
  // Diagnostic: warn when caller skips both dedupe hints. We can still resolve
  // via fuzzy name match (B3) or create a new row, but any project created
  // without a hint will have `git_repo_url IS NULL`, so future sessions for
  // the same repo will keep missing B1/B2 and risk spawning duplicates.
  if (!hints?.gitRepoUrl && !hints?.localPath) {
    console.warn(
      `[ensureProject] No gitRepoUrl/localPath hint for project "${projectName}" (user=${userId}). ` +
      `Falling back to fuzzy name match — risk of duplicate project on future sessions. ` +
      `Agent should pass \`git remote get-url origin\` and absolute workspace path to corn_session_start.`,
    )
  }

  if (hints?.gitRepoUrl) {
    const found = await findProjectByGitUrl(userId, hints.gitRepoUrl)
    if (found) return found
  }
  if (hints?.localPath) {
    const found = await findProjectByLocalPath(userId, hints.localPath)
    if (found) return found
  }

  const found = await findProjectByFuzzyName(userId, projectName)
  if (found) return found

  // No match — create new project, persisting the hint for future resolution.
  const existingOrg = await Organization.findOne({ user_id: userId }, { _id: 1 })
    .sort({ created_at: 1 })
    .lean()

  let orgId: string
  if (existingOrg) {
    orgId = existingOrg._id
  } else {
    orgId = generateId('org')
    await Organization.create({
      _id: orgId,
      name: 'My Workspace',
      slug: 'my-workspace',
      description: 'Auto-created default organization',
      user_id: userId,
    } as Parameters<typeof Organization.create>[0])
  }

  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const projId = generateId('proj')
  const persistedUrl = hints?.gitRepoUrl || hints?.localPath || null
  await Project.create({
    _id: projId,
    org_id: orgId,
    name: projectName,
    slug,
    description: 'Auto-created from agent session',
    git_repo_url: persistedUrl,
  } as Parameters<typeof Project.create>[0])

  return projId
}

// POST — agent write (API key)
sessionsRouter.post('/', apiKeyAuthMiddleware, async (c) => {
  const body = await c.req.json()
  const { agentKeyId, agentUserId } = getAgentCtx(c)

  // Auto-resolve or create project. Pass gitRepoUrl/localPath hints so the
  // agent's session links to its existing project (created via UI/CLI) rather
  // than spawning a duplicate. See ensureProject() for match priority.
  let projectId: string | null = body.projectId || null
  if (!projectId && body.project && agentUserId) {
    projectId = await ensureProject(body.project, agentUserId, {
      gitRepoUrl: typeof body.gitRepoUrl === 'string' ? body.gitRepoUrl : undefined,
      localPath: typeof body.localPath === 'string' ? body.localPath : undefined,
    })
  }

  // Fall back to a generated id if the agent omits one. The schema has a
  // declared `_id` (String, required) which switches Mongoose's auto-id
  // off, so passing undefined would throw `document must have an _id`.
  const sessionId = typeof body.id === 'string' && body.id ? body.id : generateId('ses')

  await SessionHandoff.create({
    _id: sessionId,
    from_agent: agentKeyId || body.agentId || 'unknown',
    project: body.project,
    task_summary: body.taskSummary,
    context: { branch: body.branch },
    status: body.status || 'active',
    project_id: projectId,
    last_activity_at: new Date(),
  } as Parameters<typeof SessionHandoff.create>[0])

  return c.json({ ok: true, id: sessionId, projectId })
})

// PATCH — agent update (API key)
// Also serves as a heartbeat: any PATCH refreshes `last_activity_at`, so
// long-running agents that periodically PATCH stay out of the auto-close sweep.
sessionsRouter.patch('/:id', apiKeyAuthMiddleware, async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json()

  // The session_handoffs schema persists `context` as Mixed JSON. Caller
  // shape here matches the legacy SQL JSON.stringify payload one-for-one.
  const context = {
    summary: body.summary,
    filesChanged: body.filesChanged,
    decisions: body.decisions,
    blockers: body.blockers,
  }

  await SessionHandoff.updateOne(
    { _id: id },
    {
      $set: {
        status: body.status || 'completed',
        context,
        last_activity_at: new Date(),
      },
    },
  )

  return c.json({ ok: true })
})

// POST /:id/heartbeat — lightweight keep-alive that only refreshes activity.
// Useful for agents that want to signal "still working" without committing a
// full status change yet. Idempotent and safe to call frequently.
sessionsRouter.post('/:id/heartbeat', apiKeyAuthMiddleware, async (c) => {
  const { id } = c.req.param()
  await SessionHandoff.updateOne(
    { _id: id, status: 'active' },
    { $set: { last_activity_at: new Date() } },
  )
  return c.json({ ok: true })
})
