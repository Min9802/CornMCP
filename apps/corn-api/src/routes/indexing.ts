import { Hono } from 'hono'
import { Project, IndexJob } from '../db/mongoose/index.js'
import { generateId, createLogger } from '@corn/shared-utils'
import { analyzeProject } from '../services/ast-engine.js'

const logger = createLogger('indexing')

const ACTIVE_JOB_STATUSES = ['pending', 'cloning', 'analyzing', 'ingesting'] as const

export const indexingRouter = new Hono()

// ── Start Indexing (triggers native AST analysis) ──
indexingRouter.post('/:id/index', async (c) => {
  const projectId = c.req.param('id')
  try {
    const project = await Project.findById(projectId, { git_repo_url: 1, name: 1 }).lean()
    if (!project) return c.json({ error: 'Project not found' }, 404)
    if (!project.git_repo_url) return c.json({ error: 'No git repository URL/path configured' }, 400)

    const activeJob = await IndexJob.findOne(
      { project_id: projectId, status: { $in: ACTIVE_JOB_STATUSES } },
      { _id: 1 },
    ).lean()
    if (activeJob) return c.json({ error: 'An indexing job is already running', jobId: activeJob._id }, 409)

    let branch = 'main'
    try { const body = await c.req.json(); if (body.branch) branch = body.branch } catch {}

    const jobId = generateId('idx')
    await IndexJob.create({
      _id: jobId,
      project_id: projectId,
      branch,
      status: 'analyzing',
      progress: 0,
      started_at: new Date(),
    } as Parameters<typeof IndexJob.create>[0])

    // Run AST analysis (in background — don't block the response)
    const rootDir = project.git_repo_url
    logger.info(`Starting indexing for ${project.name} at ${rootDir}`)

    // Fire and forget the analysis
    ;(async () => {
      try {
        const result = await analyzeProject(projectId, rootDir, async (progress, message) => {
          await IndexJob.updateOne(
            { _id: jobId },
            { $set: { progress, log: message, status: 'analyzing' } },
          )
        })

        await IndexJob.updateOne(
          { _id: jobId },
          {
            $set: {
              status: 'done',
              progress: 100,
              total_files: result.filesAnalyzed,
              symbols_found: result.symbolsFound,
              completed_at: new Date(),
              log: `Completed: ${result.filesAnalyzed} files, ${result.symbolsFound} symbols, ${result.edgesFound} edges`,
            },
          },
        )

        logger.info(`Indexing complete for ${project.name}: ${result.symbolsFound} symbols, ${result.edgesFound} edges`)
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        logger.error(`Indexing failed for ${project.name}:`, errMsg)
        await IndexJob.updateOne(
          { _id: jobId },
          { $set: { status: 'error', error: errMsg, completed_at: new Date() } },
        )
      }
    })()

    return c.json({ jobId, status: 'analyzing', branch, message: `AST analysis started for ${project.name}` }, 201)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Get Index Status ──
indexingRouter.get('/:id/index/status', async (c) => {
  const projectId = c.req.param('id')
  try {
    const job = await IndexJob.findOne({ project_id: projectId })
      .sort({ created_at: -1 })
      .lean()
    if (!job) return c.json({ status: 'none', message: 'No indexing jobs found' })

    return c.json({
      jobId: job._id,
      branch: job.branch,
      status: job.status,
      progress: job.progress,
      totalFiles: job.total_files,
      symbolsFound: job.symbols_found,
      log: job.log,
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
    const rawJobs = await IndexJob.find(
      { project_id: projectId },
      {
        branch: 1, status: 1, progress: 1, total_files: 1, symbols_found: 1, error: 1,
        triggered_by: 1, started_at: 1, completed_at: 1, created_at: 1,
      },
    )
      .sort({ created_at: -1 })
      .limit(limit)
      .lean()
    // Project `_id` to `id` so the dashboard payload matches the legacy
    // SQLite `id` column it has been consuming.
    const jobs = rawJobs.map(({ _id, ...rest }) => ({ id: _id, ...rest }))
    return c.json({ jobs })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Cancel Job ──
indexingRouter.post('/:id/index/cancel', async (c) => {
  const projectId = c.req.param('id')
  try {
    const activeJob = await IndexJob.findOne(
      { project_id: projectId, status: { $in: ACTIVE_JOB_STATUSES } },
      { _id: 1 },
    )
      .sort({ created_at: -1 })
      .lean()
    if (!activeJob) return c.json({ error: 'No active indexing job found' }, 404)

    await IndexJob.updateOne(
      { _id: activeJob._id },
      { $set: { status: 'error', error: 'Cancelled by user', completed_at: new Date() } },
    )
    return c.json({ success: true, jobId: activeJob._id })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})
