import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpEnv } from '@corn/shared-types'

interface ChangeEvent {
  id: string
  project_id: string
  branch: string
  agent_id: string
  commit_sha: string
  commit_message: string
  files_changed: string
  created_at: string
}

/**
 * Format change events into a human-readable summary.
 */
function formatChangeSummary(events: ChangeEvent[]): string | null {
  if (events.length === 0) return null

  const allFiles = new Set<string>()
  const lines: string[] = []

  for (const e of events) {
    const files = JSON.parse(e.files_changed || '[]') as string[]
    files.forEach(f => allFiles.add(f))
    lines.push(`- ${e.agent_id}: "${e.commit_message}" (${files.length} files, ${e.created_at})`)
  }

  return [
    `${events.length} change(s) by other agents since your last check:`,
    ...lines,
    '',
    `Affected files: ${[...allFiles].join(', ')}`,
    'Action: Run `git pull` before editing these files to avoid conflicts.',
  ].join('\n')
}

/**
 * Register change awareness tools.
 */
export function registerChangeTools(server: McpServer, env: McpEnv) {
  const apiUrl = () => (env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')

  server.tool(
    'corn_changes',
    'Check for recent code changes pushed by other agents/team members. Returns unseen commits and affected files. Call before starting work on shared branches.',
    {
      agentId: z.string().describe('Your agent identifier'),
      projectId: z.string().describe('Project ID'),
      acknowledge: z.boolean().optional().default(true).describe('Mark as seen (default: true)'),
    },
    async ({ agentId, projectId, acknowledge }) => {
      try {
        const res = await fetch(
          `${apiUrl()}/api/webhooks/changes?agentId=${encodeURIComponent(agentId)}&projectId=${encodeURIComponent(projectId)}`,
          { signal: AbortSignal.timeout(10000) },
        )

        if (!res.ok) {
          return { content: [{ type: 'text' as const, text: 'No unseen changes (or webhook service unavailable).' }] }
        }

        const { events, count } = (await res.json()) as { events: ChangeEvent[]; count: number }

        // Auto-acknowledge
        if (acknowledge !== false && events.length > 0) {
          const latestId = events[0]?.id
          if (latestId) {
            fetch(`${apiUrl()}/api/webhooks/changes/ack`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentId, projectId, lastSeenEventId: latestId }),
            }).catch(() => {})
          }
        }

        const summary = formatChangeSummary(events)

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              hasChanges: count > 0,
              count,
              summary: summary ?? 'No unseen changes.',
              events: events.map(e => ({
                id: e.id,
                agent: e.agent_id,
                branch: e.branch,
                commit: e.commit_sha?.slice(0, 7),
                message: e.commit_message,
                files: JSON.parse(e.files_changed || '[]'),
                time: e.created_at,
              })),
            }, null, 2),
          }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Changes error: ${error instanceof Error ? error.message : 'Unknown'}` }],
          isError: true,
        }
      }
    },
  )
}
