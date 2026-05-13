import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpEnv } from '@corn/shared-types'
import { generateId } from '@corn/shared-utils'
import { runTask } from '../services/task-dispatcher.js'
import { getMem9 } from '../services/embedder.js'
import {
  AUTO_TAGS_TASK_NAME,
  registerAutoTagsTask,
  type AutoTagsInput,
  type AutoTagsResult,
} from './auto-tags.js'
import {
  KNOWLEDGE_DEDUP_TASK_NAME,
  registerDedupTasks,
  type DedupCandidate,
  type DedupInput,
  type DedupResult,
} from './dedup.js'
import { getKeyOwnerUserId } from '../services/key-owner.js'

function apiHeaders(env: McpEnv): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.DASHBOARD_API_KEY) h['X-API-Key'] = env.DASHBOARD_API_KEY
  return h
}

export function registerKnowledgeTools(server: McpServer, env: McpEnv) {
  // Wire the auto-tag task with the dispatcher. Idempotent — memory.ts
  // calls the same helper, last write wins with identical refs.
  registerAutoTagsTask()
  // Dedup tasks: shared module handles both memory + knowledge. Calling
  // here as well is idempotent and defends against knowledge tools
  // being registered before memory tools.
  registerDedupTasks()

  // ─── Store Knowledge ─────────────────────────────────
  server.tool(
    'corn_knowledge_store',
    'Store a knowledge item in the shared knowledge base. Use for bug fixes, patterns, decisions, and conventions that should be available to all agents.',
    {
      title: z.string().describe('Title of the knowledge item'),
      content: z.string().describe('The knowledge content'),
      projectId: z.string().optional().describe('Associated project'),
      tags: z.array(z.string()).optional().describe('Tags for categorization. If omitted or empty, the server auto-suggests tags from title + content (heuristic by default; LLM mode toggleable in admin UI).'),
    },
    async ({ title, content, projectId, tags }) => {
      const svc = await getMem9(env)
      const id = generateId('kb')
      const agentId = (env as McpEnv & { API_KEY_OWNER?: string }).API_KEY_OWNER || 'unknown'

      // ── Dedup pre-check ──
      // Same pattern as corn_memory_store but against the knowledge
      // collection. Title + content form the search corpus so near-
      // identical articles collide even when one copy stripped the title.
      // Best-effort: failure never blocks the write.
      const dedupCorpus = title ? `${title}\n\n${content}` : content
      let dedupNote = ''
      try {
        const candidates = await svc.searchKnowledge(
          dedupCorpus,
          3,
          projectId ? { project_id: projectId } : undefined,
        )
        if (candidates.length > 0) {
          const { result, metadata } = await runTask<DedupInput, DedupResult>(
            KNOWLEDGE_DEDUP_TASK_NAME,
            {
              content: dedupCorpus,
              candidates: candidates.map<DedupCandidate>((c) => ({
                id: c.id,
                content: (c.payload?.['content'] as string) ?? '',
                score: c.score,
              })),
            },
            env,
          )
          if (result.isDuplicate) {
            const fallback = metadata.fellBack ? ', fallback' : ''
            const target = result.duplicateOfId ? ` of ${result.duplicateOfId}` : ''
            const reason = result.reason ? ` — ${result.reason}` : ''
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `🔁 Skipped duplicate knowledge${target} (${metadata.engineUsed}${fallback})${reason}\n\nNo new document stored. Retitle or add net-new info to override.`,
                },
              ],
            }
          }
          if (metadata.fellBack) {
            dedupNote = ` (dedup fell back to heuristic)`
          }
        }
      } catch {
        // Silent: dedup failure must not block store.
      }

      // Auto-tag only when caller did not supply any tags. Title is
      // included in the corpus to bias toward topical tags. Best-effort:
      // any error → keep original `tags`, never block store.
      let finalTags = tags ?? []
      let autoTagNote = ''
      if (finalTags.length === 0) {
        try {
          const corpus = title ? `${title}\n\n${content}` : content
          const { result, metadata } = await runTask<AutoTagsInput, AutoTagsResult>(
            AUTO_TAGS_TASK_NAME,
            { content: corpus },
            env,
          )
          if (result.tags.length > 0) {
            finalTags = result.tags
            const fallback = metadata.fellBack ? ', fallback' : ''
            autoTagNote = ` (auto-tagged ${metadata.engineUsed}${fallback})`
          }
        } catch {
          // Silent: registry mis-config or both engines failed → store
          // knowledge with empty tags. User can search by content.
        }
      }

      // Stamp the owner of the API key so downstream searches can scope by
      // user. Null userId (lookup failed) falls through unscoped — better to
      // write than to silently drop.
      const userId = await getKeyOwnerUserId(env)

      // Store in Qdrant vector store (corn_knowledge collection)
      await svc.storeKnowledge(id, content, {
        title,
        agent_id: agentId,
        project_id: projectId || null,
        tags: finalTags,
        source: 'agent',
        user_id: userId,
      })

      // Also register in Dashboard API if available. Errors are logged
      // so missing dashboard rows can be diagnosed; vector data above is
      // canonical and stays consistent regardless.
      try {
        const apiUrl = (env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')
        const res = await fetch(`${apiUrl}/api/knowledge`, {
          method: 'POST',
          headers: apiHeaders(env),
          body: JSON.stringify({
            id,
            title,
            content,
            source: 'agent',
            sourceAgentId: agentId,
            projectId: projectId || null,
            tags: finalTags,
          }),
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) {
          const body = await res.text().catch(() => '<unreadable>')
          console.warn(
            `[corn-mcp] dashboard sync /api/knowledge HTTP ${res.status} (id=${id}, project=${projectId || 'none'}): ${body.slice(0, 200)}`,
          )
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[corn-mcp] dashboard sync /api/knowledge network error (id=${id}): ${msg}`)
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `✅ Knowledge stored: "${title}" (id: ${id})\n\nTags: ${finalTags.join(', ') || 'none'}${autoTagNote}${dedupNote}`,
          },
        ],
      }
    },
  )

  // ─── Search Knowledge ────────────────────────────────
  server.tool(
    'corn_knowledge_search',
    'Search the shared knowledge base semantically. Find bug fixes, patterns, decisions, and conventions contributed by any agent.',
    {
      query: z.string().describe('Natural language search query'),
      limit: z.number().optional().default(5).describe('Max results'),
      projectId: z.string().optional().describe('Filter by project'),
      tags: z.array(z.string()).optional().describe('Filter by tags'),
    },
    async ({ query, limit, projectId, tags }) => {
      const svc = await getMem9(env)

      // Scope to the owner of the calling API key so we never surface another
      // tenant's docs. Null userId skips the filter (legacy keys / lookup
      // failure); the corn-api dashboard route still enforces tenancy.
      const userId = await getKeyOwnerUserId(env)

      const filter: Record<string, unknown> = {}
      if (userId) filter.user_id = userId
      if (projectId) filter.project_id = projectId

      const results = await svc.searchKnowledge(query, limit, Object.keys(filter).length > 0 ? filter : undefined)

      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No knowledge found for: "${query}"`,
            },
          ],
        }
      }

      const formatted = results
        .map((r, i) => {
          const payload = r.payload as Record<string, unknown>
          return `${i + 1}. **${payload.title || 'Untitled'}** [Score: ${r.score.toFixed(3)}]\n   By: ${payload.agent_id || 'unknown'} | Tags: ${((payload.tags as string[]) || []).join(', ') || 'none'}\n   ${(payload.content as string || '').slice(0, 200)}${(payload.content as string || '').length > 200 ? '...' : ''}`
        })
        .join('\n\n')

      return {
        content: [
          {
            type: 'text' as const,
            text: `Found ${results.length} knowledge items:\n\n${formatted}`,
          },
        ],
      }
    },
  )
}
