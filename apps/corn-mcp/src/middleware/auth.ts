import { createLogger } from '@corn/shared-utils'

const logger = createLogger('mcp-auth')

interface AuthResult {
  valid: boolean
  agentId?: string
  keyId?: string
  userId?: string
  error?: string
}

/**
 * Validate API key by calling corn-api's /api/auth/validate-key endpoint.
 * This looks up the key in the database (per-user keys) instead of env.
 *
 * Supports:
 *   - Bearer <key> (standard MCP auth)
 *   - X-API-Key: <key> (legacy)
 */
export async function validateApiKey(
  request: Request,
  env: { API_KEYS: string; DASHBOARD_API_URL?: string },
): Promise<AuthResult> {
  // Extract key from headers
  const authHeader = request.headers.get('authorization')
  const xApiKey = request.headers.get('x-api-key')

  let key: string | null = null
  if (authHeader?.startsWith('Bearer ')) {
    key = authHeader.slice(7).trim()
  } else if (xApiKey) {
    key = xApiKey.trim()
  }

  if (!key) {
    return { valid: false, error: 'No API key provided' }
  }

  const apiUrl = (env.DASHBOARD_API_URL || process.env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')

  try {
    const res = await fetch(`${apiUrl}/api/auth/validate-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(5000),
    })

    const data = await res.json() as Record<string, unknown>

    if (!data.valid) {
      logger.warn('Invalid API key attempted')
      return { valid: false, error: (data.error as string) || 'Invalid API key' }
    }

    return {
      valid: true,
      agentId: (data.keyName as string) || 'unknown',
      keyId: data.keyId as string,
      userId: data.userId as string,
    }
  } catch (err) {
    logger.error('Failed to validate API key via Dashboard API:', err)
    return { valid: false, error: 'API key validation service unavailable' }
  }
}
