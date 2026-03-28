import { Hono } from 'hono'
import { dbAll, dbGet, dbRun } from '../db/client.js'
import { generateId } from '@corn/shared-utils'

export const indexingRouter = new Hono()

// ── Start Indexing ──
indexingRouter.post('/:id/index', async (c) => {
  const projectId = c.req.param('id')
  try {
    const project = await dbGet('SELECT id, git_repo_url FROM projects WHERE id = ?', [projectId])
    if (!project) return c.json({ error: 'Project not found' }, 404)
    if (!project.git_repo_url) return c.json({ error: 'No git repository URL configured' }, 400)

    const activeJob = await dbGet(
      `SELECT id FROM index_jobs WHERE project_id = ? AND status IN ('pending', 'cloning', 'analyzing', 'ingesting')`,
      [projectId],
    )
    if (activeJob) return c.json({ error: 'An indexing job is already running', jobId: activeJob.id }, 409)

    let branch = 'main'
    try { const body = await c.req.json(); if (body.branch) branch = body.branch } catch {}

    const jobId = generateId('idx')
    await dbRun(
      `INSERT INTO index_jobs (id, project_id, branch, status, progress) VALUES (?, ?, ?, 'pending', 0)`,
      [jobId, projectId, branch],
    )

    return c.json({ jobId, status: 'pending', branch }, 201)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Get Index Status ──
indexingRouter.get('/:id/index/status', async (c) => {
  const projectId = c.req.param('id')
  try {
    const job = await dbGet(
      `SELECT * FROM index_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    )
    if (!job) return c.json({ status: 'none', message: 'No indexing jobs found' })

    return c.json({
      jobId: job.id,
      branch: job.branch,
      status: job.status,
      progress: job.progress,
      totalFiles: job.total_files,
      symbolsFound: job.symbols_found,
      error: job.error,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      createdAt: job.created_at,
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Get Index History ──
indexingRouter.get('/:id/index/history', async (c) => {
  const projectId = c.req.param('id')
  const limit = Math.min(50, Number(c.req.query('limit') || '10'))

  try {
    const jobs = await dbAll(
      `SELECT id, branch, status, progress, total_files, symbols_found, error,
              triggered_by, started_at, completed_at, created_at
       FROM index_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
      [projectId, limit],
    )
    return c.json({ jobs })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Cancel Job ──
indexingRouter.post('/:id/index/cancel', async (c) => {
  const projectId = c.req.param('id')
  try {
    const activeJob = await dbGet(
      `SELECT id FROM index_jobs WHERE project_id = ? AND status IN ('pending', 'cloning', 'analyzing', 'ingesting') ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    )
    if (!activeJob) return c.json({ error: 'No active indexing job found' }, 404)

    await dbRun(
      `UPDATE index_jobs SET status = 'error', error = 'Cancelled by user', completed_at = datetime('now') WHERE id = ?`,
      [activeJob.id],
    )
    return c.json({ success: true, jobId: activeJob.id })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})
