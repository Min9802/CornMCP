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

async function findProjectByGitUrl(userId: string, gitRepoUrl: string): Promise<string | null> {
  for (const variant of gitUrlVariants(gitRepoUrl)) {
    const p = await dbGet(
      `SELECT p.id FROM projects p
       JOIN organizations o ON p.org_id = o.id
       WHERE LOWER(p.git_repo_url) = LOWER(?) AND (o.user_id = ? OR o.user_id IS NULL)
       LIMIT 1`,
      [variant, userId],
    )
    if (p) return p['id'] as string
  }
  return null
}

async function findProjectByLocalPath(userId: string, localPath: string): Promise<string | null> {
  const norm = normalizePath(localPath)
  if (!norm) return null
  const projects = await dbAll(
    `SELECT p.id, p.git_repo_url FROM projects p
     JOIN organizations o ON p.org_id = o.id
     WHERE p.git_repo_url IS NOT NULL AND (o.user_id = ? OR o.user_id IS NULL)`,
    [userId],
  )
  for (const p of projects) {
    const stored = p['git_repo_url'] as string | null
    if (stored && normalizePath(stored) === norm) return p['id'] as string
  }
  return null
}

async function findProjectByFuzzyName(userId: string, projectName: string): Promise<string | null> {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const fuzzy = projectName.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!fuzzy) return null
  const p = await dbGet(
    `SELECT p.id FROM projects p
     JOIN organizations o ON p.org_id = o.id
     WHERE (
       p.slug = ?
       OR REPLACE(REPLACE(LOWER(p.slug), '-', ''), '_', '') = ?
       OR REPLACE(REPLACE(LOWER(p.name), '-', ''), '_', '') = ?
     ) AND (o.user_id = ? OR o.user_id IS NULL)
     LIMIT 1`,
    [slug, fuzzy, fuzzy, userId],
  )
  return p ? (p['id'] as string) : null
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
  // Update `.agent/workflows/rules_handoff_cornhub.md` step 2 if agents keep
  // omitting these.
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

  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const projId = generateId('proj')
  const persistedUrl = hints?.gitRepoUrl || hints?.localPath || null
  await dbRun(
    `INSERT INTO projects (id, org_id, name, slug, description, git_repo_url) VALUES (?, ?, ?, ?, ?, ?)`,
    [projId, org['id'], projectName, slug, 'Auto-created from agent session', persistedUrl],
  )

  return projId
}

// POST — agent write (API key)
sessionsRouter.post('/', apiKeyAuthMiddleware, async (c) => {
  const body = await c.req.json()
  const { agentKeyId, agentUserId } = getAgentCtx(c)

  // Auto-resolve or create project. Pass gitRepoUrl/localPath hints so the
  // agent's session links to its existing project (created via UI/CLI) rather
  // than spawning a duplicate. See ensureProject() for match priority.
  let projectId = body.projectId || null
  if (!projectId && body.project && agentUserId) {
    projectId = await ensureProject(body.project, agentUserId, {
      gitRepoUrl: typeof body.gitRepoUrl === 'string' ? body.gitRepoUrl : undefined,
      localPath: typeof body.localPath === 'string' ? body.localPath : undefined,
    })
  }

  await dbRun(
    `INSERT INTO session_handoffs (id, from_agent, project, task_summary, context, status, project_id, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
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
// Also serves as a heartbeat: any PATCH refreshes `last_activity_at`, so
// long-running agents that periodically PATCH stay out of the auto-close sweep.
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
    `UPDATE session_handoffs
     SET status = ?, context = ?, last_activity_at = datetime('now')
     WHERE id = ?`,
    [body.status || 'completed', context, id],
  )

  return c.json({ ok: true })
})

// POST /:id/heartbeat — lightweight keep-alive that only refreshes activity.
// Useful for agents that want to signal "still working" without committing a
// full status change yet. Idempotent and safe to call frequently.
sessionsRouter.post('/:id/heartbeat', apiKeyAuthMiddleware, async (c) => {
  const { id } = c.req.param()
  await dbRun(
    `UPDATE session_handoffs
     SET last_activity_at = datetime('now')
     WHERE id = ? AND status = 'active'`,
    [id],
  )
  return c.json({ ok: true })
})
