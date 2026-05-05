import { dbAll, dbRun } from '../db/client.js'
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
    await dbRun(
      `UPDATE session_handoffs
       SET last_activity_at = datetime('now')
       WHERE id = ? AND status = 'active'`,
      [sessionId],
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
    await dbRun(
      `UPDATE session_handoffs
       SET last_activity_at = datetime('now')
       WHERE from_agent = ? AND status = 'active'`,
      [agentId],
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

  const expired = await dbAll(
    `SELECT id, context
     FROM session_handoffs
     WHERE status = 'active'
       AND datetime(COALESCE(last_activity_at, created_at)) <= datetime('now', ? )`,
    [`-${timeoutMinutes} minutes`],
  )

  if (expired.length === 0) return { closed: 0, ids: [] }

  const closedAt = new Date().toISOString()
  const ids: string[] = []

  for (const row of expired) {
    const id = row['id'] as string
    const rawContext = row['context'] as string | null
    let parsed: Record<string, unknown> = {}
    try {
      parsed = rawContext ? (JSON.parse(rawContext) as Record<string, unknown>) : {}
    } catch {
      parsed = { raw: rawContext }
    }
    parsed['autoClosed'] = true
    parsed['autoClosedAt'] = closedAt
    parsed['autoCloseReason'] = `inactive_for_${timeoutMinutes}m`

    try {
      await dbRun(
        `UPDATE session_handoffs SET status = 'abandoned', context = ? WHERE id = ? AND status = 'active'`,
        [JSON.stringify(parsed), id],
      )
      ids.push(id)
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
