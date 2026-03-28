import { Hono } from 'hono'
import { dbAll, dbGet, dbRun } from '../db/client.js'

export const intelRouter = new Hono()

const GITNEXUS_URL = () => process.env['GITNEXUS_URL'] ?? 'http://gitnexus:4848'

/**
 * Proxy calls to GitNexus eval-server (when available).
 * If GitNexus is not running, returns graceful fallback responses.
 */
async function callGitNexus(tool: string, params: Record<string, unknown>): Promise<unknown> {
  const url = `${GITNEXUS_URL()}/tool/${tool}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(text || `GitNexus ${tool} failed: ${res.status}`)
  try { return JSON.parse(text) } catch { return { raw: text.trim() } }
}

function resolveRepoName(projectId: string): string {
  // Resolve project ID → repo name for GitNexus
  // Simple: try by slug, then project ID directly
  return projectId
}

// ── Search ──
intelRouter.post('/search', async (c) => {
  try {
    const body = await c.req.json()
    const { query, limit, projectId, branch } = body
    if (!query) return c.json({ error: 'Query is required' }, 400)

    const params: Record<string, unknown> = { query, limit: limit ?? 5, content: true }
    if (projectId) params.repo = resolveRepoName(projectId)
    if (branch) params.branch = branch

    const results = await callGitNexus('query', params)
    const formatted = `🔍 Search: "${query}"\n\n${JSON.stringify(results, null, 2)}`
    return c.json({ success: true, data: { query, formatted, results } })
  } catch (error) {
    return c.json({ success: false, error: String(error), hint: 'Ensure GitNexus is running and repos are indexed.' }, 500)
  }
})

// ── Impact ──
intelRouter.post('/impact', async (c) => {
  try {
    const body = await c.req.json()
    const { target, direction, projectId } = body
    if (!target) return c.json({ error: 'Target is required' }, 400)

    const params: Record<string, unknown> = { target, direction: direction ?? 'downstream' }
    if (projectId) params.repo = resolveRepoName(projectId)

    const results = await callGitNexus('impact', params)
    return c.json({ success: true, data: { target, direction: direction ?? 'downstream', results } })
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500)
  }
})

// ── Context ──
intelRouter.post('/context', async (c) => {
  try {
    const body = await c.req.json()
    const { name, projectId, file } = body
    if (!name) return c.json({ error: 'Symbol name is required' }, 400)

    const params: Record<string, unknown> = { name, content: true }
    if (file) params.file = file
    if (projectId) params.repo = resolveRepoName(projectId)

    const results = await callGitNexus('context', params)
    return c.json({ success: true, data: { name, results } })
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500)
  }
})

// ── Detect Changes ──
intelRouter.post('/detect-changes', async (c) => {
  try {
    const body = await c.req.json()
    const { scope, projectId } = body
    const params: Record<string, unknown> = { scope: scope ?? 'all' }
    if (projectId) params.repo = resolveRepoName(projectId)
    const results = await callGitNexus('detect_changes', params)
    return c.json({ success: true, data: results })
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500)
  }
})

// ── Cypher ──
intelRouter.post('/cypher', async (c) => {
  try {
    const body = await c.req.json()
    const { query: cypherQuery, projectId } = body
    if (!cypherQuery) return c.json({ error: 'Cypher query is required' }, 400)
    const params: Record<string, unknown> = { query: cypherQuery }
    if (projectId) params.repo = resolveRepoName(projectId)
    const results = await callGitNexus('cypher', params)
    return c.json({ success: true, data: results })
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500)
  }
})

// ── List Repos ──
intelRouter.get('/repos', async (c) => {
  try {
    const projects = await dbAll('SELECT id, slug, name, git_repo_url, indexed_symbols FROM projects')
    return c.json({ success: true, data: projects })
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500)
  }
})

// ── File Content (code_read proxy) ──
intelRouter.post('/file-content', async (c) => {
  try {
    const body = await c.req.json()
    const { projectId, file, startLine, endLine } = body
    if (!file || !projectId) return c.json({ success: false, error: 'projectId and file are required' }, 400)

    // Try GitNexus first
    try {
      const results = await callGitNexus('read_file', { file, repo: resolveRepoName(projectId) })
      return c.json({ success: true, data: { file, content: typeof results === 'string' ? results : JSON.stringify(results) } })
    } catch {
      return c.json({ success: false, error: 'File not found or GitNexus unavailable', suggestions: [] }, 404)
    }
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500)
  }
})
