import { SessionHandoff } from '../db/mongoose/index.js'
import { createLogger } from '@corn/shared-utils'

const logger = createLogger('session-lifecycle')

/**
 * Bump `last_activity_at` for an active session. No-op for sessions that are
 * already completed/abandoned/expired so the auto-close job can't be defeated
 * by stale touches. Best-effort: failures are swallowed so callers stay simple.
 */
export async function touchSession(sessionId: string): Promise<void> {
  if (!sessionId) return
  try {
    await SessionHandoff.updateOne(
      { _id: sessionId, status: 'active' },
      { $set: { last_activity_at: new Date() } },
    )
  } catch (err) {
    logger.warn(`touchSession failed for ${sessionId}: ${(err as Error).message}`)
  }
}

/**
 * Bump `last_activity_at` for every active session owned by `agentId`. Used by
 * the telemetry pipeline so any tool call by the agent acts as an implicit
 * heartbeat — long-running agents stay alive without remembering to PATCH.
 *
 * Note: an agent can have multiple parallel sessions (different projects);
 * this refreshes them all, which is the desired behaviour because the agent
 * is demonstrably still working.
 */
export async function touchSessionsByAgent(agentId: string): Promise<void> {
  if (!agentId) return
  try {
    await SessionHandoff.updateMany(
      { from_agent: agentId, status: 'active' },
      { $set: { last_activity_at: new Date() } },
    )
  } catch (err) {
    logger.warn(`touchSessionsByAgent failed for ${agentId}: ${(err as Error).message}`)
  }
}

export interface AutoCloseResult {
  closed: number
  ids: string[]
}

/**
 * Mark active sessions whose `last_activity_at` is older than `timeoutMinutes`
 * as 'abandoned' and stamp the context with auto-close metadata. Returns the
 * IDs that were closed so callers can log/notify.
 */
export async function autoCloseInactiveSessions(
  timeoutMinutes: number,
): Promise<AutoCloseResult> {
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    return { closed: 0, ids: [] }
  }

  // SQL version used `COALESCE(last_activity_at, created_at)` to handle
  // pre-migration rows that hadn't backfilled last_activity_at yet. The
  // 0005 migration backfills it from created_at, and the Mongo schema
  // defaults the field to `Date.now`, so plain `last_activity_at` is
  // sufficient post-migration.
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000)

  const expired = await SessionHandoff.find(
    { status: 'active', last_activity_at: { $lte: cutoff } },
    { _id: 1, context: 1 },
  ).lean()

  if (expired.length === 0) return { closed: 0, ids: [] }

  const closedAt = new Date().toISOString()
  const ids: string[] = []

  for (const row of expired) {
    const id = row._id
    // `context` is Mixed JSON — may be an object, a string (legacy SQLite
    // rows that hadn't been parsed yet), or null.
    let parsed: Record<string, unknown> = {}
    if (row.context && typeof row.context === 'object' && !Array.isArray(row.context)) {
      parsed = { ...(row.context as Record<string, unknown>) }
    } else if (typeof row.context === 'string') {
      try {
        parsed = JSON.parse(row.context) as Record<string, unknown>
      } catch {
        parsed = { raw: row.context }
      }
    }
    parsed['autoClosed'] = true
    parsed['autoClosedAt'] = closedAt
    parsed['autoCloseReason'] = `inactive_for_${timeoutMinutes}m`

    try {
      const res = await SessionHandoff.updateOne(
        { _id: id, status: 'active' },
        { $set: { status: 'abandoned', context: parsed } },
      )
      if (res.modifiedCount > 0) ids.push(id)
    } catch (err) {
      logger.warn(`auto-close failed for ${id}: ${(err as Error).message}`)
    }
  }

  return { closed: ids.length, ids }
}

export interface LifecycleJobOptions {
  timeoutMinutes: number
  checkIntervalMs: number
}

/**
 * Schedule the auto-close sweep. Runs once on start (after a short delay so
 * the API can begin serving) then every `checkIntervalMs`. Returns a cancel
 * fn — handy for tests and graceful shutdown.
 */
export function startSessionLifecycleJob(opts: LifecycleJobOptions): () => void {
  const { timeoutMinutes, checkIntervalMs } = opts

  const tick = async () => {
    try {
      const res = await autoCloseInactiveSessions(timeoutMinutes)
      if (res.closed > 0) {
        logger.info(
          `Auto-closed ${res.closed} inactive session(s) (>${timeoutMinutes}m): ${res.ids.join(', ')}`,
        )
      }
    } catch (err) {
      logger.error(`session lifecycle tick failed: ${(err as Error).message}`)
    }
  }

  // First sweep shortly after boot so stale sessions from prior crashes get
  // cleaned up without waiting a full interval.
  const initial = setTimeout(tick, 30_000)
  const handle = setInterval(tick, checkIntervalMs)

  return () => {
    clearTimeout(initial)
    clearInterval(handle)
  }
}
