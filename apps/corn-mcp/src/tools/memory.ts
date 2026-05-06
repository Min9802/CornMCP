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
    'Store a memory scoped to a specific project. projectId is REQUIRED — memory is project-isolated to prevent cross-project pollution. For cross-project shared knowledge (patterns, decisions, conventions), use corn_knowledge_store instead.',
    {
      content: z.string().describe('The memory content to store'),
      projectId: z
        .string()
        .min(1)
        .describe('REQUIRED. Project scope for the memory (e.g. proj-xxx). Memories are isolated per project. Use corn_knowledge_store for cross-project items.'),
      branch: z.string().optional().describe('Git branch scope'),
      tags: z.array(z.string()).optional().describe('Tags for categorization (e.g. ["session-log", "<feature>"])'),
    },
    async ({ content, projectId, branch, tags }) => {
      const svc = await getMem9(env)
      const id = generateId('mem')
      const agentId = (env as McpEnv & { API_KEY_OWNER?: string }).API_KEY_OWNER || 'unknown'

      await svc.storeMemory(id, content, {
        agent_id: agentId,
        project_id: projectId,
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
            projectId,
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
            text: `✅ Memory stored (id: ${id}, project: ${projectId})\n\nContent: "${content.slice(0, 100)}${content.length > 100 ? '...' : ''}"`,
          },
        ],
      }
    },
  )

  // ─── Search Memory ───────────────────────────────────
  server.tool(
    'corn_memory_search',
    'Search agent memories by semantic similarity within a project (default) or across all projects (opt-in). Use feature/context keywords from the user task (e.g. "auth login", "session timeout"). Run multiple queries with different keywords if the task spans domains.',
    {
      query: z.string().describe('Natural language search query — use feature/context keywords from the task, not generic terms'),
      limit: z.number().optional().default(5).describe('Max results (default: 5)'),
      projectId: z
        .string()
        .optional()
        .describe('Project scope for the search. REQUIRED unless crossProject is true.'),
      branch: z.string().optional().describe('Filter by branch'),
      crossProject: z
        .boolean()
        .optional()
        .default(false)
        .describe('Set true to search across ALL projects (rare — only when intentionally pulling lessons from other repos). Mutually exclusive with projectId.'),
    },
    async ({ query, limit, projectId, branch, crossProject }) => {
      // Enforce project scope: either explicit projectId, or explicit cross-project opt-in.
      if (!crossProject && !projectId) {
        throw new Error(
          'corn_memory_search: projectId is required. Pass projectId of the current project, or set crossProject:true to search across all projects.',
        )
      }
      if (crossProject && projectId) {
        throw new Error(
          'corn_memory_search: cannot pass both projectId and crossProject:true. Choose one — projectId for scoped search, crossProject:true for global search.',
        )
      }

      const svc = await getMem9(env)

      const filter: Record<string, unknown> = {}
      if (!crossProject && projectId) filter.project_id = projectId
      if (branch) filter.branch = branch

      const results = await svc.searchMemory(query, limit, Object.keys(filter).length > 0 ? filter : undefined)

      if (results.length === 0) {
        const scopeLabel = crossProject ? 'all projects' : `project ${projectId}`
        return {
          content: [
            {
              type: 'text' as const,
              text: `No memories found for "${query}" (scope: ${scopeLabel}).`,
            },
          ],
        }
      }

      const scopeLabel = crossProject ? 'all projects' : `project ${projectId}`
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
            text: `Found ${results.length} memories (scope: ${scopeLabel}):\n\n${formatted}`,
          },
        ],
      }
    },
  )
}
