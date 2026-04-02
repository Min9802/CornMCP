import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

import { registerHealthTools } from './tools/health.js'
import { registerMemoryTools } from './tools/memory.js'
import { registerKnowledgeTools } from './tools/knowledge.js'
import { registerQualityTools } from './tools/quality.js'
import { registerSessionTools } from './tools/session.js'
import { registerCodeTools } from './tools/code.js'
import { registerAnalyticsTools } from './tools/analytics.js'
import { registerChangeTools } from './tools/changes.js'
import { validateApiKey } from './middleware/auth.js'
import type { Env } from './types.js'

const app = new Hono<{ Bindings: Env }>()

// Bridge process.env → c.env for Node.js runtime
app.use('*', async (c, next) => {
  const envKeys: (keyof Env)[] = [
    'QDRANT_URL',
    'DASHBOARD_API_URL',
    'DASHBOARD_API_KEY',
    'MCP_SERVER_NAME',
    'MCP_SERVER_VERSION',
    'API_KEYS',
  ]
  for (const key of envKeys) {
    if (!c.env[key] && process.env[key]) {
      ;(c.env as unknown as Record<string, string>)[key] = process.env[key]!
    }
  }
  await next()
})

app.use('*', cors())
app.use('*', logger())

// Global error handler
app.onError((err, c) => {
  console.error('[MCP Global Error]', err.message, err.stack)
  return c.json(
    {
      jsonrpc: '2.0',
      error: { code: -32603, message: err.message },
      id: null,
    },
    500,
  )
})

// Health endpoint (no auth)
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    service: 'corn-mcp',
    version: c.env.MCP_SERVER_VERSION ?? '0.1.0',
    timestamp: new Date().toISOString(),
  })
})

// ─── OAuth Discovery ──────────────────────────────────
// VS Code Copilot probes these endpoints before connecting.
// We tell it: "use Bearer token in header, no OAuth flow needed."
const getBaseUrl = (reqUrl: string, path: string) => {
  const u = new URL(reqUrl)
  return `${u.protocol}//${u.host}${path}`
}

app.get('/.well-known/oauth-protected-resource/mcp', (c) => {
  return c.json({
    resource: getBaseUrl(c.req.url, '/mcp'),
    bearer_methods_supported: ['header'],
  })
})

app.get('/.well-known/oauth-protected-resource', (c) => {
  return c.json({
    resource: getBaseUrl(c.req.url, '/'),
    bearer_methods_supported: ['header'],
  })
})

// Return a minimal authorization server metadata so VS Code doesn't
// trigger the "Dynamic Client Registration not supported" dialog.
app.get('/.well-known/oauth-authorization-server', (c) => {
  const base = getBaseUrl(c.req.url, '')
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    registration_endpoint: `${base}/register`,
  })
})

app.get('/.well-known/openid-configuration', (c) => {
  const base = getBaseUrl(c.req.url, '')
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
  })
})

// Dynamic client registration — accept any request, return a fake client_id
app.post('/register', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  return c.json({
    client_id: 'corn-mcp-client',
    client_secret: '',
    client_name: (body as any).client_name || 'VS Code',
    redirect_uris: (body as any).redirect_uris || [],
  })
})

// OAuth authorize — redirect back with the Bearer token as code
app.get('/oauth/authorize', (c) => {
  const redirectUri = c.req.query('redirect_uri')
  const state = c.req.query('state')
  if (!redirectUri) return c.text('Missing redirect_uri', 400)
  const url = new URL(redirectUri)
  url.searchParams.set('code', 'corn-auth-code')
  if (state) url.searchParams.set('state', state)
  return c.redirect(url.toString())
})

// OAuth token — exchange code for the API key (from Authorization header)
app.post('/oauth/token', async (c) => {
  return c.json({
    access_token: 'provide-your-api-key',
    token_type: 'Bearer',
    expires_in: 3600 * 24 * 365,
  })
})

// Root — server info
app.get('/', (c) => {
  return c.json({
    name: 'Corn Hub MCP Server',
    version: c.env.MCP_SERVER_VERSION ?? '0.1.0',
    mcp: '/mcp',
    health: '/health',
    tools: [
      'corn_health',
      'corn_memory_store',
      'corn_memory_search',
      'corn_knowledge_store',
      'corn_knowledge_search',
      'corn_quality_report',
      'corn_plan_quality',
      'corn_session_start',
      'corn_session_end',
      'corn_code_search',
      'corn_code_impact',
      'corn_code_context',
      'corn_detect_changes',
      'corn_cypher',
      'corn_list_repos',
      'corn_code_read',
      'corn_tool_stats',
      'corn_changes',
    ],
  })
})

// Helper: create MCP server with tools
export function createMcpServer(env: Env) {
  const server = new McpServer({
    name: env.MCP_SERVER_NAME ?? 'corn-hub',
    version: env.MCP_SERVER_VERSION ?? '0.1.0',
  })
  registerHealthTools(server, env)
  registerMemoryTools(server, env)
  registerKnowledgeTools(server, env)
  registerQualityTools(server, env)
  registerSessionTools(server, env)
  registerCodeTools(server, env)
  registerAnalyticsTools(server, env)
  registerChangeTools(server, env)
  return server
}

// ─── MCP Streamable HTTP handler ──────────────────────────
app.all('/mcp', async (c) => {
  const envWithOwner = { ...c.env } as Env & { API_KEY_OWNER?: string }

  // Extract raw API key for forwarding to corn-api
  const authHeader = c.req.header('authorization')
  const xApiKey = c.req.header('x-api-key')
  let rawApiKey: string | undefined
  if (authHeader?.startsWith('Bearer ')) rawApiKey = authHeader.slice(7).trim()
  else if (xApiKey) rawApiKey = xApiKey.trim()

  // Auth
  try {
    const authResult = await validateApiKey(c.req.raw, c.env)
    if (!authResult.valid) {
      return c.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: `Unauthorized: ${authResult.error || 'Invalid API key'}. Get a key from the Dashboard → API Keys.`,
          },
          id: null,
        },
        401,
      )
    }
    if (authResult.agentId) {
      envWithOwner.API_KEY_OWNER = authResult.agentId
    }
    // Forward the raw API key so tools can authenticate with corn-api
    if (rawApiKey) {
      envWithOwner.DASHBOARD_API_KEY = rawApiKey
    }
  } catch (err) {
    return c.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: `Auth service unavailable: ${String(err)}`,
        },
        id: null,
      },
      503,
    )
  }

  const mcpServer = createMcpServer(envWithOwner)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
    enableJsonResponse: true,
  })

  await mcpServer.connect(transport)

  // Read body and create new request for transport
  let bodyText = ''
  try {
    bodyText = await c.req.text()
  } catch {}

  const newReq = new Request(c.req.raw.url, {
    method: c.req.raw.method,
    headers: c.req.raw.headers,
    body: bodyText,
  })

  // Log tool calls for telemetry
  let toolName = 'unknown'
  try {
    const p = JSON.parse(bodyText)
    if (p.method === 'tools/call') {
      toolName = p.params?.name
    }
  } catch {}

  const startTime = Date.now()

  try {
    const response = await transport.handleRequest(newReq)
    const latencyMs = Date.now() - startTime

    // Log to Dashboard API (best effort)
    if (toolName !== 'unknown') {
      const apiUrl = (c.env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')
      const telemetryHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
      if (c.env.DASHBOARD_API_KEY) telemetryHeaders['X-API-Key'] = c.env.DASHBOARD_API_KEY
      fetch(`${apiUrl}/api/metrics/query-log`, {
        method: 'POST',
        headers: telemetryHeaders,
        body: JSON.stringify({
          agentId: envWithOwner.API_KEY_OWNER || 'unknown',
          tool: toolName,
          status: response.status >= 400 ? 'error' : 'ok',
          latencyMs,
          inputSize: bodyText.length,
        }),
      }).catch(() => {})
    }

    return response
  } catch (error: any) {
    console.error('[MCP Streamable Error]', error)
    return c.json(
      {
        jsonrpc: '2.0',
        error: { code: -32603, message: error.message || 'Internal error' },
        id: null,
      },
      500,
    )
  }
})

export default app
