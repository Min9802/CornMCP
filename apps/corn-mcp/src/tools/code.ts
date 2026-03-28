import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpEnv } from '@corn/shared-types'

/**
 * Code intelligence tools — proxy calls to Dashboard API → GitNexus backend.
 * Provides AST graph queries, impact analysis, semantic code search, and file reading.
 */
export function registerCodeTools(server: McpServer, env: McpEnv) {
  const apiUrl = () => (env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')

  async function callIntel(endpoint: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
    const res = await fetch(`${apiUrl()}/api/intel/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`${endpoint} failed: ${res.status} ${await res.text()}`)
    return res.json()
  }

  // ── corn_code_search — semantic codebase search ──
  server.tool(
    'corn_code_search',
    'Search the codebase for architecture concepts, execution flows, and file matches using hybrid vector/AST search. Supply projectId to scope to a specific project.',
    {
      query: z.string().describe('Natural language or code query'),
      projectId: z.string().optional().describe('Project ID to scope search to'),
      branch: z.string().optional().describe('Git branch to search'),
      limit: z.number().optional().describe('Max results (default: 5)'),
    },
    async ({ query, projectId, branch, limit }) => {
      try {
        const data = (await callIntel('search', {
          query, projectId, branch, limit: limit ?? 5,
        })) as { data?: { formatted?: string }; success?: boolean }

        let formatted = data?.data?.formatted ?? ''

        if (!formatted || formatted.includes('No matching')) {
          const terms = query.split(/\s+/).filter(w => w.length > 3).slice(0, 2)
          const sym = terms[0] ?? query
          formatted += `\n\n---\nNext: Run corn_code_context "${sym}" to see callers, callees, and flows.`
          formatted += `\nAlternative: Use corn_cypher 'MATCH (n) WHERE n.name CONTAINS "${sym}" RETURN n.name, labels(n) LIMIT 20'.`
        }

        // Supplement with Qdrant semantic code search
        if (projectId) {
          try {
            const codeRes = await fetch(`${apiUrl()}/api/intel/code-search`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query, projectId, branch, limit: limit ?? 5 }),
              signal: AbortSignal.timeout(15000),
            })
            if (codeRes.ok) {
              const codeData = (await codeRes.json()) as { data?: { results?: Array<{ score: number; filePath?: string; content?: string }> } }
              const results = codeData?.data?.results ?? []
              if (results.length > 0) {
                const lines = ['\n\n📄 **Source Code Matches** (semantic search)\n']
                for (const hit of results.slice(0, 5)) {
                  const ext = hit.filePath?.split('.').pop() ?? ''
                  const lang = { ts: 'typescript', js: 'javascript', cs: 'csharp', py: 'python', go: 'go' }[ext] ?? ext
                  lines.push(`### ${hit.filePath ?? 'unknown'} (${(hit.score * 100).toFixed(1)}% match)`)
                  if (hit.content) { lines.push(`\`\`\`${lang}\n${hit.content.slice(0, 2000)}\n\`\`\``) }
                }
                formatted += lines.join('\n')
              }
            }
          } catch { /* best-effort */ }
        }

        return { content: [{ type: 'text' as const, text: formatted || JSON.stringify(data, null, 2) }] }
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Code search error: ${error instanceof Error ? error.message : 'Unknown'}` }], isError: true }
      }
    },
  )

  // ── corn_code_impact — blast radius analysis ──
  server.tool(
    'corn_code_impact',
    'Analyze the blast radius of changing a specific symbol (function, class, file) to verify downstream impact before making edits.',
    {
      target: z.string().describe('Function, class, or file to analyze'),
      projectId: z.string().optional().describe('Project ID'),
      branch: z.string().optional().describe('Git branch'),
      direction: z.enum(['upstream', 'downstream']).optional().describe('Direction (default: downstream)'),
    },
    async ({ target, projectId, branch, direction }) => {
      try {
        const data = (await callIntel('impact', {
          target, projectId, branch, direction: direction ?? 'downstream',
        })) as { data?: { results?: { raw?: string } } }

        const raw = data?.data?.results?.raw ?? ''

        // Auto-retry: if "isolated", try context lookup to find methods
        if (raw.includes('appears isolated') || raw.includes('not found')) {
          try {
            const ctxData = (await callIntel('context', { name: target, projectId })) as { data?: { results?: { raw?: string } } }
            const ctxRaw = ctxData?.data?.results?.raw ?? ''
            const methodMatches = ctxRaw.match(/\[has_method\]\s+\w+\s+\w+/g)

            if (methodMatches && methodMatches.length > 0) {
              const methods = methodMatches.map(m => m.split(/\s+/).pop()!).filter(m => m !== target)
              const lines = [`📋 Class "${target}" — ${methods.length} method(s) found:\n`, ...methods.map(m => `  • ${m}`), '']

              if (methods.length > 0) {
                try {
                  const mImpact = (await callIntel('impact', { target: methods[0], projectId, direction: direction ?? 'downstream' })) as { data?: { results?: { raw?: string } } }
                  const mRaw = mImpact?.data?.results?.raw ?? ''
                  if (!mRaw.includes('appears isolated')) { lines.push(`\n🎯 Impact for "${methods[0]}":\n`, mRaw) }
                } catch { /* ignore */ }
              }
              lines.push(`\n💡 Run corn_code_impact on specific methods for detailed blast radius.`)
              return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
            }
          } catch { /* fallthrough */ }
        }

        return { content: [{ type: 'text' as const, text: raw || JSON.stringify(data, null, 2) }] }
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Impact analysis error: ${error instanceof Error ? error.message : 'Unknown'}` }], isError: true }
      }
    },
  )

  // ── corn_code_context — 360° symbol view ──
  server.tool(
    'corn_code_context',
    'Get a 360° view of a code symbol: its methods, callers, callees, and related execution flows. Essential for exploring class hierarchies.',
    {
      name: z.string().describe('Function, class, or symbol to explore'),
      projectId: z.string().optional().describe('Project ID'),
      file: z.string().optional().describe('File path to disambiguate'),
    },
    async ({ name, projectId, file }) => {
      try {
        const data = (await callIntel('context', { name, projectId, file })) as { data?: { results?: { raw?: string } } }
        return { content: [{ type: 'text' as const, text: data?.data?.results?.raw ?? JSON.stringify(data, null, 2) }] }
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Context error: ${error instanceof Error ? error.message : 'Unknown'}` }], isError: true }
      }
    },
  )

  // ── corn_detect_changes — pre-commit risk analysis ──
  server.tool(
    'corn_detect_changes',
    'Detect uncommitted changes and analyze their risk level. Shows changed symbols, affected processes, and risk assessment.',
    {
      scope: z.string().optional().describe('"all" (default), "staged", or "unstaged"'),
      projectId: z.string().optional().describe('Project ID'),
    },
    async ({ scope, projectId }) => {
      try {
        const data = await callIntel('detect-changes', { scope: scope ?? 'all', projectId })
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Detect changes error: ${error instanceof Error ? error.message : 'Unknown'}` }], isError: true }
      }
    },
  )

  // ── corn_cypher — direct graph queries ──
  server.tool(
    'corn_cypher',
    'Run Cypher queries against the code knowledge graph. Supports MATCH, RETURN, WHERE, ORDER BY.\nExample: MATCH (n) WHERE n.name CONTAINS "Auth" RETURN n.name, labels(n) LIMIT 20',
    {
      query: z.string().describe('Cypher query'),
      projectId: z.string().optional().describe('Project ID'),
    },
    async ({ query, projectId }) => {
      try {
        const data = await callIntel('cypher', { query, projectId })
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown'
        const hint = msg.includes('Cannot find property')
          ? '\n\n💡 Available properties: name, filePath. Use labels(n) for node type.'
          : ''
        return { content: [{ type: 'text' as const, text: `Cypher error: ${msg}${hint}` }], isError: true }
      }
    },
  )

  // ── corn_list_repos — discover indexed repositories ──
  server.tool(
    'corn_list_repos',
    'List all indexed repositories with project ID mapping. Use this to find which projectId to pass to code tools.',
    {},
    async () => {
      try {
        const res = await fetch(`${apiUrl()}/api/intel/repos`, { signal: AbortSignal.timeout(10000) })
        if (!res.ok) throw new Error(`Failed: ${res.status}`)
        const data = (await res.json()) as { data?: unknown }
        const repos = Array.isArray(data?.data) ? data.data : []

        if (repos.length === 0) {
          return { content: [{ type: 'text' as const, text: '📦 No indexed repositories found.\n\n💡 Use the Dashboard → Projects to index a repository.' }] }
        }

        const lines = ['📦 Indexed Repositories\n', '| # | Repository | Project ID | Symbols |', '|---|-----------|-----------|---------|']
        const seen = new Map<string, any>()
        for (const r of repos) {
          const name = r.name ?? r.repo ?? 'unknown'
          if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), r)
        }
        let i = 0
        for (const [, r] of seen) {
          i++
          lines.push(`| ${i} | **${r.name ?? 'unknown'}** | \`${r.projectId ?? '(auto)'}\` | ${r.symbols ?? '?'} |`)
        }
        lines.push('', `Total: ${seen.size} repos.`, '\n💡 Pass the Project ID to corn_code_search, corn_code_context, corn_code_impact, or corn_cypher.')

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `List repos error: ${error instanceof Error ? error.message : 'Unknown'}` }], isError: true }
      }
    },
  )

  // ── corn_code_read — read raw source file ──
  server.tool(
    'corn_code_read',
    'Read raw source code from an indexed repository. Returns full file or a line range. Use after corn_code_search to view files.',
    {
      file: z.string().describe('Relative file path (e.g., "src/utils/auth.ts")'),
      projectId: z.string().describe('Project ID'),
      startLine: z.number().optional().describe('Start line (1-indexed)'),
      endLine: z.number().optional().describe('End line (1-indexed)'),
    },
    async ({ file, projectId, startLine, endLine }) => {
      try {
        const res = await fetch(`${apiUrl()}/api/intel/file-content`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, file, startLine, endLine }),
          signal: AbortSignal.timeout(10000),
        })
        const data = (await res.json()) as { success?: boolean; data?: { file?: string; totalLines?: number; content?: string; startLine?: number; endLine?: number; sizeBytes?: number }; error?: string; suggestions?: string[] }

        if (!res.ok || !data.success) {
          let msg = data.error ?? `Failed: ${res.status}`
          if (data.suggestions?.length) { msg += '\n\nDid you mean:\n' + data.suggestions.map(s => `  → ${s}`).join('\n') }
          return { content: [{ type: 'text' as const, text: msg }], isError: true }
        }

        const d = data.data!
        const ext = (d.file ?? '').split('.').pop() ?? ''
        const lang = { ts: 'typescript', js: 'javascript', cs: 'csharp', py: 'python', go: 'go', rs: 'rust' }[ext] ?? ext
        const header = `📄 **${d.file}** (${d.totalLines} lines${d.sizeBytes ? `, ${Math.round(d.sizeBytes / 1024)}KB` : ''})`
        const range = d.startLine && d.endLine ? `\nLines ${d.startLine}-${d.endLine}` : ''

        return { content: [{ type: 'text' as const, text: `${header}${range}\n\n\`\`\`${lang}\n${d.content}\n\`\`\`` }] }
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Code read error: ${error instanceof Error ? error.message : 'Unknown'}` }], isError: true }
      }
    },
  )
}
