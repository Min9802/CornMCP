import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpEnv } from '@corn/shared-types'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, resolve, normalize, relative } from 'node:path'

/**
 * Code intelligence tools — proxy calls to Dashboard API → GitNexus backend.
 * Falls back to local git/fs operations when GitNexus is unavailable.
 */
export function registerCodeTools(server: McpServer, env: McpEnv) {
  const apiUrl = () => (env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')

  // ── Resolve project root for local fallbacks ──
  function getProjectRoot(): string {
    // Walk up from cwd to find a .git directory
    let dir = process.cwd()
    for (let i = 0; i < 10; i++) {
      if (existsSync(join(dir, '.git'))) return dir
      const parent = resolve(dir, '..')
      if (parent === dir) break
      dir = parent
    }
    return process.cwd()
  }

  function execGit(args: string, cwd?: string): string {
    try {
      return execSync(`git ${args}`, {
        cwd: cwd ?? getProjectRoot(),
        timeout: 10000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
    } catch {
      return ''
    }
  }

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
        let data: { data?: { formatted?: string }; success?: boolean } = { success: false }
        try {
          data = (await callIntel('search', {
            query, projectId, branch, limit: limit ?? 5,
          })) as any
        } catch { /* GitNexus fail — continue to local fallback */ }

        let formatted = data?.data?.formatted ?? ''

        // Local fallback: use git grep
        if (!formatted || formatted.includes('No matching')) {
          const terms = query.split(/\s+/).filter(w => w.length > 3).slice(0, 3)
          if (terms.length > 0) {
            const grepResults = execGit(`grep -n -i --color=never "${terms.join('\\|')}" -- "*.ts" "*.tsx" "*.js" "*.jsx" "*.py" "*.go" "*.rs" | head -30`)
            if (grepResults) {
              const lines = ['📄 **Local Search Results** (git grep)\n']
              const resultLines = grepResults.split('\n').slice(0, 20)
              let currentFile = ''
              for (const line of resultLines) {
                const match = line.match(/^([^:]+):(\d+):(.*)$/)
                if (match) {
                  const [, file, lineNum, content] = match
                  if (file !== currentFile) {
                    currentFile = file!
                    lines.push(`\n### ${file}`)
                  }
                  lines.push(`L${lineNum}: ${content!.trim()}`)
                }
              }
              formatted = lines.join('\n')
            }
          }

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
      // Try GitNexus first
      try {
        const res = await fetch(`${apiUrl()}/api/intel/file-content`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, file, startLine, endLine }),
          signal: AbortSignal.timeout(10000),
        })
        const data = (await res.json()) as { success?: boolean; data?: { file?: string; totalLines?: number; content?: string; startLine?: number; endLine?: number; sizeBytes?: number }; error?: string; suggestions?: string[] }

        if (res.ok && data.success) {
          const d = data.data!
          const ext = (d.file ?? '').split('.').pop() ?? ''
          const lang = { ts: 'typescript', js: 'javascript', cs: 'csharp', py: 'python', go: 'go', rs: 'rust' }[ext] ?? ext
          const header = `📄 **${d.file}** (${d.totalLines} lines${d.sizeBytes ? `, ${Math.round(d.sizeBytes / 1024)}KB` : ''})`
          const range = d.startLine && d.endLine ? `\nLines ${d.startLine}-${d.endLine}` : ''
          return { content: [{ type: 'text' as const, text: `${header}${range}\n\n\`\`\`${lang}\n${d.content}\n\`\`\`` }] }
        }
      } catch { /* GitNexus unavailable — fall through to local */ }

      // Local filesystem fallback
      try {
        const root = getProjectRoot()
        const filePath = normalize(join(root, file))

        // Security: prevent path traversal outside project
        if (!filePath.startsWith(root)) {
          return { content: [{ type: 'text' as const, text: `Error: Path traversal not allowed` }], isError: true }
        }

        if (!existsSync(filePath)) {
          // Try to find the file with fuzzy matching
          const suggestions = findSimilarFiles(root, file)
          let msg = `File not found: ${file}`
          if (suggestions.length > 0) {
            msg += '\n\nDid you mean:\n' + suggestions.map(s => `  → ${s}`).join('\n')
          }
          return { content: [{ type: 'text' as const, text: msg }], isError: true }
        }

        const rawContent = readFileSync(filePath, 'utf-8')
        const allLines = rawContent.split('\n')
        const totalLines = allLines.length
        const sizeBytes = Buffer.byteLength(rawContent, 'utf-8')

        const start = startLine ? Math.max(1, startLine) : 1
        const end = endLine ? Math.min(endLine, totalLines) : totalLines
        const selectedLines = allLines.slice(start - 1, end)

        // Add line numbers
        const numberedContent = selectedLines
          .map((line, i) => `${String(start + i).padStart(4, ' ')} │ ${line}`)
          .join('\n')

        const ext = file.split('.').pop() ?? ''
        const lang = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', go: 'go', rs: 'rust', css: 'css', json: 'json', md: 'markdown', sql: 'sql', yaml: 'yaml', yml: 'yaml' }[ext] ?? ext
        const header = `📄 **${file}** (${totalLines} lines, ${Math.round(sizeBytes / 1024)}KB) — *local read*`
        const range = (startLine || endLine) ? `\nLines ${start}-${end} of ${totalLines}` : ''

        return { content: [{ type: 'text' as const, text: `${header}${range}\n\n\`\`\`${lang}\n${numberedContent}\n\`\`\`` }] }
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Code read error: ${error instanceof Error ? error.message : 'Unknown'}` }], isError: true }
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
      // Try GitNexus first
      try {
        const data = (await callIntel('context', { name, projectId, file })) as { data?: { results?: { raw?: string } } }
        const raw = data?.data?.results?.raw
        if (raw) return { content: [{ type: 'text' as const, text: raw }] }
      } catch { /* GitNexus unavailable — fall through to local */ }

      // Local fallback: use git grep to find symbol references
      try {
        const root = getProjectRoot()
        const grepDef = execGit(`grep -n --color=never -E "(function|class|interface|type|const|let|var|export)\\s+${name}" -- "*.ts" "*.tsx" "*.js" "*.jsx"`)
        const grepUsage = execGit(`grep -n --color=never "${name}" -- "*.ts" "*.tsx" "*.js" "*.jsx" | head -30`)

        const lines: string[] = [`🔍 **Symbol: \`${name}\`** — *local analysis*\n`]

        // Definitions
        if (grepDef) {
          lines.push('### 📌 Definitions\n')
          for (const line of grepDef.split('\n').slice(0, 10)) {
            const match = line.match(/^([^:]+):(\d+):(.*)$/)
            if (match) {
              lines.push(`- **${match[1]}:${match[2]}** — \`${match[3]!.trim()}\``)
            }
          }
        }

        // References
        if (grepUsage) {
          const refs = grepUsage.split('\n')
          const defFiles = new Set(grepDef.split('\n').map(l => l.split(':')[0]))
          const usageOnly = refs.filter(r => {
            const f = r.split(':')[0]
            return !defFiles.has(f)
          })

          if (usageOnly.length > 0) {
            lines.push('\n### 📎 References (callers/importers)\n')
            const fileGroups = new Map<string, string[]>()
            for (const line of usageOnly.slice(0, 20)) {
              const match = line.match(/^([^:]+):(\d+):(.*)$/)
              if (match) {
                const f = match[1]!
                if (!fileGroups.has(f)) fileGroups.set(f, [])
                fileGroups.get(f)!.push(`L${match[2]}: ${match[3]!.trim()}`)
              }
            }
            for (const [f, lns] of fileGroups) {
              lines.push(`\n**${f}**`)
              for (const ln of lns.slice(0, 5)) lines.push(`  ${ln}`)
            }
          }
        }

        if (!grepDef && !grepUsage) {
          lines.push(`No references found for \`${name}\` in the current repository.`)
          lines.push(`\n💡 Try: \`corn_code_search "${name}"\` for a broader search.`)
        }

        lines.push(`\n---\n💡 This is a local analysis using \`git grep\`. For full AST-level context (callers, callees, type hierarchy), deploy the GitNexus engine.`)

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Context analysis error: ${error instanceof Error ? error.message : 'Unknown'}` }], isError: true }
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
      // Try GitNexus first
      try {
        const data = (await callIntel('impact', {
          target, projectId, branch, direction: direction ?? 'downstream',
        })) as { data?: { results?: { raw?: string } } }

        const raw = data?.data?.results?.raw ?? ''
        if (raw && !raw.includes('appears isolated') && !raw.includes('not found')) {
          return { content: [{ type: 'text' as const, text: raw }] }
        }
      } catch { /* GitNexus unavailable — fall through to local */ }

      // Local fallback: find all files that import/reference the target
      try {
        const dir = direction ?? 'downstream'
        const lines: string[] = [`💥 **Impact Analysis: \`${target}\`** (${dir}) — *local analysis*\n`]

        if (dir === 'downstream') {
          // Find who imports/uses this symbol
          const grepImport = execGit(`grep -rl --color=never "${target}" -- "*.ts" "*.tsx" "*.js" "*.jsx"`)
          const grepExact = execGit(`grep -n --color=never "${target}" -- "*.ts" "*.tsx" "*.js" "*.jsx" | head -40`)

          if (grepImport) {
            const files = grepImport.split('\n').filter(Boolean)
            lines.push(`### 🎯 Files referencing \`${target}\` (${files.length} files)\n`)

            for (const f of files.slice(0, 15)) {
              // Count occurrences in each file
              const fileGrep = execGit(`grep -c --color=never "${target}" -- "${f}"`)
              const count = parseInt(fileGrep) || 0
              const isImport = execGit(`grep -l --color=never "import.*${target}" -- "${f}"`)
              const marker = isImport ? '📥 imports' : '📎 references'
              lines.push(`- **${f}** — ${count} occurrence(s) (${marker})`)
            }

            if (files.length > 15) {
              lines.push(`\n... and ${files.length - 15} more file(s)`)
            }
          } else {
            lines.push(`No downstream references found for \`${target}\`.`)
          }
        } else {
          // Upstream: find what symbol depends on
          const grepDep = execGit(`grep -n --color=never "import" -- "*.ts" "*.tsx" "*.js" "*.jsx" | grep -i "${target}" | head -20`)
          if (grepDep) {
            lines.push(`### 🔼 Dependencies of \`${target}\`\n`)
            for (const line of grepDep.split('\n').filter(Boolean)) {
              const match = line.match(/^([^:]+):(\d+):(.*)$/)
              if (match) {
                lines.push(`- **${match[1]}:${match[2]}** — \`${match[3]!.trim()}\``)
              }
            }
          } else {
            lines.push(`No upstream dependencies found for \`${target}\`.`)
          }
        }

        lines.push(`\n---\n💡 This is a text-based analysis using \`git grep\`. For full AST-level impact (call graph, type hierarchy), deploy the GitNexus engine.`)
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Impact analysis error: ${error instanceof Error ? error.message : 'Unknown'}` }], isError: true }
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
      // Try GitNexus first
      try {
        const data = await callIntel('detect-changes', { scope: scope ?? 'all', projectId })
        if (data && typeof data === 'object') {
          return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
        }
      } catch { /* GitNexus unavailable — fall through to local */ }

      // Local fallback: use git directly
      try {
        const root = getProjectRoot()
        const selectedScope = scope ?? 'all'

        let statusCmd = 'status --porcelain'
        let diffCmd = 'diff --stat'

        if (selectedScope === 'staged') {
          statusCmd = 'diff --cached --name-status'
          diffCmd = 'diff --cached --stat'
        } else if (selectedScope === 'unstaged') {
          statusCmd = 'diff --name-status'
          diffCmd = 'diff --stat'
        }

        const status = execGit(statusCmd)
        const diffStat = execGit(diffCmd)
        const branch = execGit('branch --show-current')
        const lastCommit = execGit('log -1 --oneline')

        if (!status && !diffStat) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'clean',
                scope: selectedScope,
                branch,
                lastCommit,
                message: 'Working tree is clean. No uncommitted changes.',
                changedFiles: [],
                risk: 'none',
              }, null, 2),
            }],
          }
        }

        // Parse changed files
        const changedFiles: { file: string; status: string }[] = []
        for (const line of status.split('\n').filter(Boolean)) {
          const match = line.match(/^\s*([MADRCU?!]+)\s+(.+)$/)
          if (match) {
            const statusMap: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'unmerged', '??': 'untracked', '!!': 'ignored' }
            changedFiles.push({ file: match[2]!, status: statusMap[match[1]!] ?? match[1]! })
          }
        }

        // Risk assessment
        const criticalFiles = changedFiles.filter(f =>
          f.file.includes('schema') || f.file.includes('index.ts') || f.file.includes('.env') ||
          f.file.includes('package.json') || f.file.includes('docker') || f.file.includes('Dockerfile'),
        )
        const risk = criticalFiles.length > 0 ? 'high' : changedFiles.length > 5 ? 'medium' : 'low'

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'dirty',
              scope: selectedScope,
              branch,
              lastCommit,
              totalChanges: changedFiles.length,
              changedFiles,
              criticalFiles: criticalFiles.map(f => f.file),
              risk,
              riskReason: criticalFiles.length > 0
                ? `${criticalFiles.length} critical file(s) changed: ${criticalFiles.map(f => f.file).join(', ')}`
                : changedFiles.length > 5 ? `${changedFiles.length} files changed (high volume)` : 'Low number of non-critical changes',
              diffSummary: diffStat || 'No diff available',
              source: 'local-git',
            }, null, 2),
          }],
        }
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Change detection error: ${error instanceof Error ? error.message : 'Unknown'}` }], isError: true }
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
      // Try GitNexus first
      try {
        const data = await callIntel('cypher', { query, projectId })
        if (data && typeof data === 'object') {
          return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
        }
      } catch { /* GitNexus unavailable — fall through to local */ }

      // Local fallback: parse the Cypher query and attempt a basic symbol search
      try {
        // Extract the search term from common Cypher patterns
        const containsMatch = query.match(/CONTAINS\s+"([^"]+)"/i)
        const nameMatch = query.match(/name\s*=\s*"([^"]+)"/i)
        const searchTerm = containsMatch?.[1] ?? nameMatch?.[1]

        if (searchTerm) {
          const grepResult = execGit(`grep -rn --color=never -E "(function|class|interface|type|const|export)\\s+\\w*${searchTerm}\\w*" -- "*.ts" "*.tsx" "*.js" "*.jsx" | head -20`)

          if (grepResult) {
            const results: { name: string; type: string; file: string; line: number }[] = []
            for (const line of grepResult.split('\n').filter(Boolean)) {
              const match = line.match(/^([^:]+):(\d+):\s*(export\s+)?(function|class|interface|type|const|let|var)\s+(\w+)/)
              if (match) {
                results.push({ name: match[5]!, type: match[4]!, file: match[1]!, line: parseInt(match[2]!) })
              }
            }

            if (results.length > 0) {
              const lines = [`🔍 **Cypher Local Fallback** — symbols matching "${searchTerm}"\n`]
              lines.push('| Name | Type | File | Line |')
              lines.push('|------|------|------|------|')
              for (const r of results) {
                lines.push(`| \`${r.name}\` | ${r.type} | ${r.file} | ${r.line} |`)
              }
              lines.push(`\n---\n💡 This is a local \`git grep\` approximation. For true Cypher graph queries (relationships, call paths), deploy the GitNexus engine.`)
              return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
            }
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: `🔍 **Cypher Local Fallback**\n\nGraph database unavailable. Your query:\n\`\`\`cypher\n${query}\n\`\`\`\n\nNo local results found. Try these alternatives:\n- \`corn_code_search "${searchTerm ?? 'your search'}"\` — semantic search\n- \`corn_code_context "${searchTerm ?? 'SymbolName'}"\` — 360° symbol view\n- \`corn_code_impact "${searchTerm ?? 'SymbolName'}"\` — blast radius\n\n💡 For true Cypher queries, deploy the GitNexus graph engine.`,
          }],
        }
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Cypher error: ${error instanceof Error ? error.message : 'Unknown'}` }], isError: true }
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

  // ── Helper: find similar file paths for suggestions ──
  function findSimilarFiles(root: string, target: string, maxDepth = 4): string[] {
    const basename = target.split('/').pop()?.toLowerCase() ?? ''
    const matches: string[] = []

    function walk(dir: string, depth: number) {
      if (depth > maxDepth || matches.length >= 5) return
      try {
        const entries = readdirSync(dir)
        for (const entry of entries) {
          if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist' || entry === '.git') continue
          const fullPath = join(dir, entry)
          try {
            const stat = statSync(fullPath)
            if (stat.isDirectory()) {
              walk(fullPath, depth + 1)
            } else if (entry.toLowerCase().includes(basename) || basename.includes(entry.toLowerCase())) {
              matches.push(relative(root, fullPath).replace(/\\/g, '/'))
            }
          } catch { continue }
        }
      } catch { /* skip */ }
    }

    walk(root, 0)
    return matches
  }
}
