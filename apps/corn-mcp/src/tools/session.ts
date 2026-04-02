import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpEnv } from '@corn/shared-types'
import { generateId } from '@corn/shared-utils'

function apiHeaders(env: McpEnv): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.DASHBOARD_API_KEY) h['X-API-Key'] = env.DASHBOARD_API_KEY
  return h
}

export function registerSessionTools(server: McpServer, env: McpEnv) {
  // ─── Start Session ───────────────────────────────────
  server.tool(
    'corn_session_start',
    'Start a new work session. Call this at the beginning of a task to enable session tracking, quality gates, and handoff.',
    {
      project: z.string().describe('Project name or repo path'),
      branch: z.string().optional().describe('Git branch'),
      taskSummary: z.string().describe('Brief description of what you plan to do'),
    },
    async ({ project, branch, taskSummary }) => {
      const sessionId = generateId('ses')
      const agentId = (env as McpEnv & { API_KEY_OWNER?: string }).API_KEY_OWNER || 'unknown'

      // Register session with Dashboard API
      try {
        const apiUrl = (env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')
        await fetch(`${apiUrl}/api/sessions`, {
          method: 'POST',
          headers: apiHeaders(env),
          body: JSON.stringify({
            id: sessionId,
            agentId,
            project,
            branch: branch || 'main',
            taskSummary,
            status: 'active',
          }),
          signal: AbortSignal.timeout(5000),
        })
      } catch {
        // Best effort
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `✅ Session started: ${sessionId}\n\nProject: ${project}\nBranch: ${branch || 'main'}\nTask: ${taskSummary}\n\n💡 Remember to call corn_session_end when you finish.`,
          },
        ],
      }
    },
  )

  // ─── End Session ─────────────────────────────────────
  server.tool(
    'corn_session_end',
    'End the current work session. Provide a summary of changes and decisions for handoff.',
    {
      sessionId: z.string().describe('Session ID from corn_session_start'),
      summary: z.string().describe('Summary of what was accomplished'),
      filesChanged: z.array(z.string()).optional().describe('List of files modified'),
      decisions: z.array(z.string()).optional().describe('Key decisions made'),
      blockers: z.array(z.string()).optional().describe('Remaining blockers'),
    },
    async ({ sessionId, summary, filesChanged, decisions, blockers }) => {
      const agentId = (env as McpEnv & { API_KEY_OWNER?: string }).API_KEY_OWNER || 'unknown'

      // Update session in Dashboard API
      try {
        const apiUrl = (env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')
        await fetch(`${apiUrl}/api/sessions/${sessionId}`, {
          method: 'PATCH',
          headers: apiHeaders(env),
          body: JSON.stringify({
            status: 'completed',
            summary,
            filesChanged: filesChanged || [],
            decisions: decisions || [],
            blockers: blockers || [],
            completedAt: new Date().toISOString(),
          }),
          signal: AbortSignal.timeout(5000),
        })
      } catch {
        // Best effort
      }

      const parts = [`✅ Session ${sessionId} completed`, `\nSummary: ${summary}`]
      if (filesChanged?.length) parts.push(`\nFiles: ${filesChanged.join(', ')}`)
      if (decisions?.length) parts.push(`\nDecisions:\n${decisions.map((d) => `  • ${d}`).join('\n')}`)
      if (blockers?.length) parts.push(`\n⚠️ Blockers:\n${blockers.map((b) => `  • ${b}`).join('\n')}`)

      return {
        content: [{ type: 'text' as const, text: parts.join('') }],
      }
    },
  )
}
