import { Hono } from 'hono'
import type { QueryFilter, PipelineStage } from 'mongoose'
import { generateId } from '@corn/shared-utils'
import { QualityReport, type QualityReportDoc } from '../db/mongoose/index.js'
import { jwtAuthMiddleware, anyAuthMiddleware, getAuthCtx, getAgentCtx } from '../middleware/auth.js'
import { touchSession } from '../services/session-lifecycle.js'

export const qualityRouter = new Hono()

qualityRouter.get('/', jwtAuthMiddleware, async (c) => {
  const { user, projectIds } = getAuthCtx(c)
  const limit = Number(c.req.query('limit') || '50')

  const filter: QueryFilter<QualityReportDoc> = {}
  if (user.role !== 'admin') {
    // Non-admin: own report OR project they have access to.
    const owners: QueryFilter<QualityReportDoc>[] = [{ user_id: user.id }]
    if (projectIds.length > 0) owners.push({ project_id: { $in: projectIds } })
    filter.$or = owners
  }

  const reports = await QualityReport.find(filter)
    .sort({ created_at: -1 })
    .limit(limit)
    .lean()

  return c.json({ reports })
})

qualityRouter.post('/', anyAuthMiddleware, async (c) => {
  const body = await c.req.json()
  const authSource = (c as any).get('authSource') as string

  let userId: string | null = null
  if (authSource === 'jwt') {
    const { user } = getAuthCtx(c)
    userId = user.id
    const { projectIds } = getAuthCtx(c)
    if (body.projectId && !projectIds.includes(body.projectId) && user.role !== 'admin') {
      return c.json({ error: 'Access denied: project not found' }, 403)
    }
  } else {
    const { agentUserId, agentUserProjectIds } = getAgentCtx(c)
    userId = agentUserId
    if (body.projectId && agentUserProjectIds.length > 0 && !agentUserProjectIds.includes(body.projectId)) {
      return c.json({ error: 'Access denied: project does not belong to this API key owner' }, 403)
    }
  }

  // Schema declares `_id: { type: String, required: true }`, which disables
  // Mongoose auto-id. Synthesize one if the caller omits it so the create()
  // call doesn't throw `document must have an _id before saving`.
  const reportId = typeof body.id === 'string' && body.id ? body.id : generateId('qr')

  await QualityReport.create({
    _id: reportId,
    project_id: body.projectId || null,
    agent_id: body.agentId,
    session_id: body.sessionId || null,
    gate_name: body.gateName,
    score_build: body.scoreBuild,
    score_regression: body.scoreRegression,
    score_standards: body.scoreStandards,
    score_traceability: body.scoreTraceability,
    score_total: body.scoreTotal,
    grade: body.grade,
    passed: !!body.passed,
    details: body.details ?? null,
    user_id: userId,
  } as Parameters<typeof QualityReport.create>[0])

  // Treat a quality report as session activity so long-running sessions
  // that submit gates periodically don't get auto-closed.
  if (body.sessionId) await touchSession(body.sessionId)

  return c.json({ ok: true, id: reportId })
})

qualityRouter.get('/trends', jwtAuthMiddleware, async (c) => {
  const { user, projectIds } = getAuthCtx(c)

  const matchStage: PipelineStage.Match['$match'] = {}
  if (user.role !== 'admin') {
    const owners: Record<string, unknown>[] = [{ user_id: user.id }]
    if (projectIds.length > 0) owners.push({ project_id: { $in: projectIds } })
    matchStage.$or = owners
  }

  const trends = await QualityReport.aggregate<{
    date: string
    avg_score: number
    count: number
  }>([
    ...(Object.keys(matchStage).length ? [{ $match: matchStage }] : []),
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } },
        avg_score: { $avg: '$score_total' },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: -1 } },
    { $limit: 30 },
    { $project: { _id: 0, date: '$_id', avg_score: 1, count: 1 } },
  ])

  return c.json({ trends })
})

