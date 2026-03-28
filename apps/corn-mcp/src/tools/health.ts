import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpEnv } from '@corn/shared-types'

export function registerHealthTools(server: McpServer, env: McpEnv) {
  server.tool(
    'corn_health',
    'Check Corn Hub system health — services, uptime, version',
    {},
    async () => {
      const services: Record<string, string> = {}

      // Check Qdrant
      try {
        const res = await fetch(`${env.QDRANT_URL}/healthz`, {
          signal: AbortSignal.timeout(3000),
        })
        services.qdrant = res.ok ? 'ok' : 'error'
      } catch {
        services.qdrant = 'error'
      }

      // Check Dashboard API
      try {
        const apiUrl = (env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')
        const res = await fetch(`${apiUrl}/health`, {
          signal: AbortSignal.timeout(3000),
        })
        services.api = res.ok ? 'ok' : 'error'
      } catch {
        services.api = 'error'
      }

      const allOk = Object.values(services).every((s) => s === 'ok')

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                status: allOk ? 'healthy' : 'degraded',
                version: env.MCP_SERVER_VERSION || '0.1.0',
                services,
                timestamp: new Date().toISOString(),
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )
}
