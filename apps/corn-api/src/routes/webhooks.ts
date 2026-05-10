// Cross-agent change-feed webhooks. Mongoose-backed.
//   POST /push       — record a ChangeEvent for a repo push.
//   GET  /changes    — stream unseen events for one (agent, project).
//   POST /changes/ack— idempotent checkpoint via AgentAck.

import { Hono } from 'hono'
import { generateId } from '@corn/shared-utils'
import {
  AgentAck,
  agentAckId,
  ChangeEvent,
  Project,
} from '../db/mongoose/index.js'

export const webhooksRouter = new Hono()

// ── Push event (from git hooks, CI, or agents) ──
webhooksRouter.post('/push', async (c) => {
  try {
    const body = await c.req.json()
    const { repo, branch, agentId, commitSha, commitMessage, filesChanged } = body

    if (!repo || !branch) {
      return c.json({ error: 'repo and branch are required' }, 400)
    }

    // Look up project by git URL — accept both with and without `.git` suffix.
    const project = await Project.findOne(
      { git_repo_url: { $in: [repo, String(repo).replace(/\.git$/, '')] } },
      { _id: 1 },
    ).lean()

    if (!project) {
      return c.json({ ignored: true, reason: 'No matching project found' })
    }

    // Record change event. files_changed is stored as a string array on
    // the schema; normalize the input to one.
    const eventId = generateId('chg')
    const filesArr = Array.isArray(filesChanged)
      ? filesChanged.map((f: unknown) => String(f))
      : []
    await ChangeEvent.create({
      _id: eventId,
      project_id: project._id,
      branch,
      agent_id: agentId ?? 'local',
      commit_sha: commitSha ?? '',
      commit_message: commitMessage ?? '',
      files_changed: filesArr,
    } as Parameters<typeof ChangeEvent.create>[0])

    return c.json({ received: true, eventId, projectId: project._id })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Get unseen changes for an agent ──
webhooksRouter.get('/changes', async (c) => {
  const agentId = c.req.query('agentId')
  const projectId = c.req.query('projectId')
  const limit = Math.max(1, Math.min(200, Number(c.req.query('limit') || '20')))

  if (!agentId || !projectId) {
    return c.json({ error: 'agentId and projectId are required' }, 400)
  }

  try {
    const ack = await AgentAck.findById(agentAckId(agentId, projectId), {
      last_seen_event_id: 1,
    }).lean()

    // Fall back to "last 24h" when the agent has never acked anything.
    const fallbackCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)

    let cutoff: Date = fallbackCutoff
    if (ack?.last_seen_event_id) {
      const seen = await ChangeEvent.findById(ack.last_seen_event_id, {
        created_at: 1,
      }).lean()
      if (seen?.created_at) cutoff = seen.created_at
    }

    const events = await ChangeEvent.find(
      {
        project_id: projectId,
        agent_id: { $ne: agentId },
        created_at: { $gt: cutoff },
      },
    )
      .sort({ created_at: -1 })
      .limit(limit)
      .lean()

    // Preserve the legacy `id` field shape consumed by the dashboard/MCP.
    const enriched = (events as Array<Record<string, unknown> & { _id: string }>).map((e) => ({
      ...e,
      id: e._id,
    }))
    return c.json({ events: enriched, count: enriched.length })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ── Acknowledge changes ──
webhooksRouter.post('/changes/ack', async (c) => {
  try {
    const { agentId, projectId, lastSeenEventId } = await c.req.json()
    if (!agentId || !projectId || !lastSeenEventId) {
      return c.json({ error: 'agentId, projectId, and lastSeenEventId are required' }, 400)
    }

    // Synthetic _id replaces the SQL composite PK (agent_id, project_id).
    // findOneAndUpdate({ upsert: true }) is the idiomatic ON CONFLICT.
    await AgentAck.findOneAndUpdate(
      { _id: agentAckId(agentId, projectId) },
      {
        $set: {
          agent_id: agentId,
          project_id: projectId,
          last_seen_event_id: lastSeenEventId,
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    )

    return c.json({ acknowledged: true })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})
