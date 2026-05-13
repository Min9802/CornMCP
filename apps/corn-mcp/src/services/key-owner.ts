// Resolve the user_id (and role) that owns the configured DASHBOARD_API_KEY by
// asking corn-api `/api/auth/validate-key`. Result is cached in-process for the
// lifetime of the MCP server — keys don't transfer ownership at runtime, and a
// stale cache surfaces only on cold start.
//
// This lets vector-store writes/searches in tools/memory.ts and tools/knowledge.ts
// stamp + filter Qdrant payloads by user_id, closing the cross-tenant leak that
// `corn_memory_search crossProject:true` otherwise opens up.
//
// Failure mode: if the API is unreachable or the key is invalid, return null.
// Callers should treat null as "do not stamp user_id" so writes still succeed,
// and search filters fall back to project-only scope.

import type { McpEnv } from '@corn/shared-types'

export interface KeyOwner {
  userId: string | null
  userRole: 'admin' | 'user' | null
}

let cached: KeyOwner | null = null
let inFlight: Promise<KeyOwner> | null = null

/** Reset the cache. Test-only — production never needs this. */
export function resetKeyOwnerCache(): void {
  cached = null
  inFlight = null
}

/**
 * Resolve owner of the configured DASHBOARD_API_KEY. Cached forever after the
 * first successful lookup. Returns `{ userId: null, userRole: null }` on any
 * failure so callers can degrade gracefully.
 */
export async function getKeyOwner(env: McpEnv): Promise<KeyOwner> {
  if (cached) return cached

  // Coalesce concurrent callers so we only hit the API once on cold start.
  if (inFlight) return inFlight

  inFlight = (async () => {
    const apiUrl = (env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')
    const key = env.DASHBOARD_API_KEY
    if (!key) {
      const empty: KeyOwner = { userId: null, userRole: null }
      cached = empty
      return empty
    }

    try {
      const res = await fetch(`${apiUrl}/api/auth/validate-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        console.warn(`[corn-mcp] key-owner lookup HTTP ${res.status} — degrading to anonymous scope`)
        const empty: KeyOwner = { userId: null, userRole: null }
        cached = empty
        return empty
      }
      const data = (await res.json()) as {
        valid?: boolean
        userId?: string | null
        userRole?: 'admin' | 'user' | null
      }
      if (!data.valid || !data.userId) {
        console.warn('[corn-mcp] key-owner returned invalid/null userId — degrading to anonymous scope')
        const empty: KeyOwner = { userId: null, userRole: null }
        cached = empty
        return empty
      }
      const owner: KeyOwner = { userId: data.userId, userRole: data.userRole ?? null }
      cached = owner
      return owner
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[corn-mcp] key-owner lookup failed: ${msg} — degrading to anonymous scope`)
      const empty: KeyOwner = { userId: null, userRole: null }
      cached = empty
      return empty
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}

/** Convenience: just the userId. Most call-sites only need this. */
export async function getKeyOwnerUserId(env: McpEnv): Promise<string | null> {
  return (await getKeyOwner(env)).userId
}
