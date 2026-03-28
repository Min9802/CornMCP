import { createLogger, hashApiKey } from '@corn/shared-utils'

const logger = createLogger('mcp-auth')

interface AuthResult {
  valid: boolean
  agentId?: string
  error?: string
}

/**
 * Validate API key from Authorization header or X-API-Key header.
 * Supports both:
 *   - Bearer <key> (standard MCP auth)
 *   - X-API-Key: <key> (legacy)
 *
 * API_KEYS env format: "key1:agent1,key2:agent2"
 */
export async function validateApiKey(
  request: Request,
  env: { API_KEYS: string },
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

  // Parse API_KEYS: "key1:agent1,key2:agent2"
  const apiKeysStr = env.API_KEYS || ''
  if (!apiKeysStr) {
    // If no keys configured, allow all (dev mode)
    logger.warn('No API_KEYS configured — allowing all requests (dev mode)')
    return { valid: true, agentId: 'dev' }
  }

  const keyPairs = apiKeysStr.split(',').map((pair) => {
    const [k, agent] = pair.split(':')
    return { key: k.trim(), agentId: agent?.trim() || 'unknown' }
  })

  const match = keyPairs.find((kp) => kp.key === key)
  if (match) {
    return { valid: true, agentId: match.agentId }
  }

  logger.warn('Invalid API key attempted')
  return { valid: false, error: 'Invalid API key' }
}
