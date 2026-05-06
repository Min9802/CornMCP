import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpEnv } from '@corn/shared-types'
import { LocalMem9Service, OpenAIEmbeddingProvider, LocalHashEmbeddingProvider } from '@corn/shared-mem9'
import type { EmbeddingProvider } from '@corn/shared-mem9'
import { generateId } from '@corn/shared-utils'

function apiHeaders(env: McpEnv): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.DASHBOARD_API_KEY) h['X-API-Key'] = env.DASHBOARD_API_KEY
  return h
}

let mem9: LocalMem9Service | null = null
let usingFallback = false

async function createEmbedder(): Promise<EmbeddingProvider> {
  const apiKey = process.env['OPENAI_API_KEY'] || ''
  const apiBase = process.env['OPENAI_API_BASE'] || 'https://api.voyageai.com/v1'
  const model = process.env['MEM9_EMBEDDING_MODEL'] || 'voyage-code-3'
  const dims = Number(process.env['MEM9_EMBEDDING_DIMS']) || 1024

  // Model rotation: comma-separated fallback list from env, or sensible defaults
  const fallbackEnv = process.env['MEM9_FALLBACK_MODELS'] || ''
  const fallbackModels = fallbackEnv
    ? fallbackEnv.split(',').map((m) => m.trim()).filter(Boolean)
    : ['voyage-4-large', 'voyage-4', 'voyage-code-2', 'voyage-4-lite']

  if (apiKey) {
    // Test the key before committing to it
    try {
      const testEmbedder = new OpenAIEmbeddingProvider(apiKey, apiBase, model, dims, fallbackModels)
      await testEmbedder.embed(['test'])
      console.error(`[corn-mcp] Embedding API key validated ✓ (primary: ${model}, fallbacks: ${fallbackModels.join(', ')})`)
      return testEmbedder
    } catch (err) {
      console.error(`[corn-mcp] Embedding API key invalid, falling back to local hash embeddings: ${err instanceof Error ? err.message : err}`)
    }
  } else {
    console.error('[corn-mcp] No OPENAI_API_KEY set, using local hash embeddings')
  }

  usingFallback = true
  return new LocalHashEmbeddingProvider(256)
}

let initPromise: Promise<LocalMem9Service> | null = null

function getMem9(env: McpEnv): Promise<LocalMem9Service> {
  if (mem9) return Promise.resolve(mem9)
  if (!initPromise) {
    initPromise = createEmbedder().then((embedder) => {
      mem9 = new LocalMem9Service(embedder, './data/mem9-vectors.db')
      return mem9
    })
  }
  return initPromise
}

export function registerMemoryTools(server: McpServer, env: McpEnv) {
  // ─── Store Memory ────────────────────────────────────
  server.tool(
    'corn_memory_store',
    'Store a memory for later recall. Agents remember across sessions. Include project and branch for scoped recall.',
    {
      content: z.string().describe('The memory content to store'),
      projectId: z.string().optional().describe('Project scope for the memory'),
      branch: z.string().optional().describe('Git branch scope'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
    },
    async ({ content, projectId, branch, tags }) => {
      const svc = await getMem9(env)
      const id = generateId('mem')
      const agentId = (env as McpEnv & { API_KEY_OWNER?: string }).API_KEY_OWNER || 'unknown'

      await svc.storeMemory(id, content, {
        agent_id: agentId,
        project_id: projectId || null,
        branch: branch || null,
        tags: tags || [],
      })

      // Best-effort: register a preview row in Dashboard API so the web UI
      // can list/audit/delete memories. Failure here must not break the MCP
      // tool — the canonical vector data is already persisted locally above.
      try {
        const apiUrl = (env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')
        await fetch(`${apiUrl}/api/memories`, {
          method: 'POST',
          headers: apiHeaders(env),
          body: JSON.stringify({
            id,
            content,
            agentId,
            projectId: projectId || null,
            branch: branch || null,
            tags: tags || [],
          }),
          signal: AbortSignal.timeout(5000),
        })
      } catch {
        // Dashboard API registration is best-effort
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `✅ Memory stored (id: ${id})\n\nContent: "${content.slice(0, 100)}${content.length > 100 ? '...' : ''}"`,
          },
        ],
      }
    },
  )

  // ─── Search Memory ───────────────────────────────────
  server.tool(
    'corn_memory_search',
    'Search agent memories by semantic similarity. Returns relevant memories from any agent.',
    {
      query: z.string().describe('Natural language search query'),
      limit: z.number().optional().default(5).describe('Max results (default: 5)'),
      projectId: z.string().optional().describe('Filter by project'),
      branch: z.string().optional().describe('Filter by branch'),
    },
    async ({ query, limit, projectId, branch }) => {
      const svc = await getMem9(env)

      const filter: Record<string, unknown> = {}
      if (projectId) filter.project_id = projectId
      if (branch) filter.branch = branch

      const results = await svc.searchMemory(query, limit, Object.keys(filter).length > 0 ? filter : undefined)

      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No memories found for: "${query}"`,
            },
          ],
        }
      }

      const formatted = results
        .map(
          (r, i) =>
            `${i + 1}. [Score: ${r.score.toFixed(3)}] (${(r.payload as Record<string, unknown>).agent_id || 'unknown'})\n   ${(r.payload as Record<string, unknown>).content}`,
        )
        .join('\n\n')

      return {
        content: [
          {
            type: 'text' as const,
            text: `Found ${results.length} memories:\n\n${formatted}`,
          },
        ],
      }
    },
  )
}
