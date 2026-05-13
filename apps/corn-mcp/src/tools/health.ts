import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpEnv } from '@corn/shared-types'
import { probeEmbeddingHealth } from '../services/embedder.js'

export function registerHealthTools(server: McpServer, env: McpEnv) {
  server.tool(
    'corn_health',
    'Check Corn Hub system health — services, uptime, version',
    {},
    async () => {
      const services: Record<string, string> = {}

      // Check Qdrant — primary vector store. Memory + knowledge tools depend
      // on this being reachable; a failure here means corn_memory_* and
      // corn_knowledge_* will surface upstream errors. Mirror to vectorStore
      // for backward-compat dashboards that still read the old field.
      const qdrantUrl = env.QDRANT_URL || process.env['QDRANT_URL'] || 'http://localhost:6333'
      let qdrantOk = false
      try {
        const res = await fetch(`${qdrantUrl}/healthz`, {
          signal: AbortSignal.timeout(2000),
        })
        qdrantOk = res.ok
        services.qdrant = res.ok ? 'ok' : 'error'
      } catch {
        services.qdrant = 'error'
      }
      services.vectorStore = qdrantOk ? 'ok' : 'error'

      // Check Dashboard API
      let apiOk = false
      try {
        const apiUrl = (env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')
        const res = await fetch(`${apiUrl}/health`, {
          signal: AbortSignal.timeout(3000),
        })
        apiOk = res.ok
        services.api = res.ok ? 'ok' : 'error'
      } catch {
        services.api = 'error'
      }

      // Check embedding provider via the shared service. Config is
      // resolved with priority: corn-api system_settings DB > env >
      // default. Status differentiates between unconfigured / invalid
      // key / unreachable so the admin sees the real failure mode
      // instead of a generic "fallback" label.
      const embed = await probeEmbeddingHealth(env)
      const embeddingStatusLabel: Record<typeof embed.status, string> = {
        ok: 'ok',
        unconfigured: 'not configured (using local fallback)',
        invalid_key: `invalid key (using local fallback): ${embed.error ?? ''}`.trim(),
        unreachable: `unreachable (using local fallback): ${embed.error ?? ''}`.trim(),
      }
      services.embeddingProvider = embeddingStatusLabel[embed.status]

      const coreOk = qdrantOk && apiOk && embed.status === 'ok'

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                status: coreOk ? 'healthy' : 'degraded',
                version: env.MCP_SERVER_VERSION || '0.1.0',
                services,
                embeddingModel: embed.model,
                embeddingBase: embed.apiBase,
                embeddingDims: embed.dims,
                embeddingSource: embed.source,
                embeddingApiKey: embed.apiKeyMasked || null,
                embeddingFallbackModels: embed.fallbackModels,
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
