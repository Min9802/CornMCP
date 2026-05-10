/**
 * One-shot script: backfill Mongo `agent_memories` from Qdrant `corn_memories`.
 *
 * Why this exists:
 *   `corn_memory_store` does a double-write — Qdrant (canonical) first, then
 *   POST /api/memories to seed the dashboard preview row. The POST is wrapped
 *   in best-effort `try/catch`, so HTTP errors (e.g. 403 from a strict
 *   ownership check) silently leave Qdrant ahead of Mongo. Web /memories
 *   reads only Mongo, so those entries become invisible.
 *
 * What it does:
 *   1. Scrolls every point in Qdrant `corn_memories` (paginated, no vectors).
 *   2. Compares `payload._id_raw` against the existing `_id` set in Mongo
 *      `agent_memories`. Anything missing gets upserted.
 *   3. Reuses the schema fields the dashboard expects: content,
 *      content_preview, agent_id, project_id, branch, tags, user_id,
 *      hit_count, created_at.
 *   4. Sets `user_id` to the first admin's id. Single-tenant deployments
 *      typically have one admin who owns everything; cross-user backfill is
 *      out of scope here.
 *
 * Idempotent — safe to re-run; bulkWrite uses upsert by `_id`.
 *
 * Usage (from repo root):
 *   docker exec corn-api node --import tsx apps/corn-api/scripts/backfill-memory-from-qdrant.ts
 *
 * Environment:
 *   MONGODB_URI   — required (read from process env)
 *   QDRANT_URL    — defaults to http://corn-qdrant:6333
 */

import { connectMongoose, disconnectMongoose, AgentMemory, User } from '../src/db/mongoose/index.js'

const QDRANT_URL = (process.env.QDRANT_URL || 'http://corn-qdrant:6333').replace(/\/$/, '')
const COLLECTION = 'corn_memories'
const SCROLL_BATCH = 250

interface QdrantPoint {
  id: string
  payload: {
    _id_raw?: string
    content?: string
    agent_id?: string | null
    project_id?: string | null
    branch?: string | null
    tags?: string[]
    stored_at?: string
  }
}

interface ScrollResponse {
  result: {
    points: QdrantPoint[]
    next_page_offset?: string | null
  }
}

async function scrollAllPoints(): Promise<QdrantPoint[]> {
  const all: QdrantPoint[] = []
  let offset: string | null | undefined = undefined
  let pageCount = 0

  do {
    const body: Record<string, unknown> = {
      limit: SCROLL_BATCH,
      with_payload: true,
      with_vector: false,
    }
    if (offset) body.offset = offset

    const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`Qdrant scroll failed: HTTP ${res.status} — ${await res.text()}`)
    }
    const json = (await res.json()) as ScrollResponse
    all.push(...json.result.points)
    offset = json.result.next_page_offset ?? null
    pageCount++
    console.log(`  page ${pageCount}: +${json.result.points.length} (total ${all.length})`)
  } while (offset)

  return all
}

async function main(): Promise<void> {
  const mongoUri = process.env.MONGODB_URI
  if (!mongoUri) {
    throw new Error('MONGODB_URI environment variable is required')
  }
  console.log('[backfill] connecting to Mongo + Qdrant...')
  await connectMongoose(mongoUri)

  console.log(`[backfill] scrolling ${COLLECTION} from ${QDRANT_URL}...`)
  const points = await scrollAllPoints()
  console.log(`[backfill] fetched ${points.length} Qdrant points`)

  const usable = points.filter((p) => {
    const pid = p.payload?._id_raw
    const content = p.payload?.content
    return typeof pid === 'string' && pid.length > 0 && typeof content === 'string'
  })
  if (usable.length !== points.length) {
    console.warn(
      `[backfill] skipping ${points.length - usable.length} points missing _id_raw or content`,
    )
  }

  const existingIds = new Set<string>(
    (await AgentMemory.find({}, { _id: 1 }).lean()).map((d) => d._id as unknown as string),
  )
  const missing = usable.filter((p) => !existingIds.has(p.payload._id_raw as string))
  console.log(
    `[backfill] Mongo has ${existingIds.size} memories; Qdrant has ${usable.length} valid points; ${missing.length} missing → will upsert`,
  )

  if (missing.length === 0) {
    console.log('[backfill] nothing to do — Mongo already in sync with Qdrant.')
    await disconnectMongoose()
    return
  }

  const admin = await User.findOne({ role: 'admin' }, { _id: 1, email: 1 }).lean()
  if (!admin) {
    throw new Error('No admin user found — cannot assign user_id for backfill')
  }
  const ownerUserId = admin._id as unknown as string
  console.log(`[backfill] assigning user_id=${ownerUserId} (${admin.email}) to backfilled rows`)

  const ops = missing.map((p) => {
    const id = p.payload._id_raw as string
    const content = p.payload.content as string
    const storedAt = p.payload.stored_at ? new Date(p.payload.stored_at) : new Date()
    return {
      updateOne: {
        filter: { _id: id } as Record<string, unknown>,
        update: {
          $set: {
            content,
            content_preview: content.slice(0, 200),
            agent_id: p.payload.agent_id ?? null,
            project_id: p.payload.project_id ?? null,
            branch: p.payload.branch ?? null,
            tags: Array.isArray(p.payload.tags) ? p.payload.tags : [],
            user_id: ownerUserId,
          },
          $setOnInsert: {
            _id: id,
            hit_count: 0,
            created_at: storedAt,
          },
        },
        upsert: true,
      },
    }
  })

  // Mongoose 9 typings dislike heterogeneous bulkWrite arrays — cast through unknown.
  const result = await AgentMemory.bulkWrite(ops as unknown as Parameters<typeof AgentMemory.bulkWrite>[0], {
    ordered: false,
  })

  console.log('[backfill] done', {
    inserted: result.upsertedCount,
    matched: result.matchedCount,
    modified: result.modifiedCount,
  })

  const finalCount = await AgentMemory.countDocuments({})
  console.log(`[backfill] Mongo agent_memories now has ${finalCount} docs`)

  await disconnectMongoose()
}

main().catch(async (err) => {
  console.error('[backfill] FAILED:', err)
  try { await disconnectMongoose() } catch { /* ignore */ }
  process.exit(1)
})
