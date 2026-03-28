import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpEnv } from '@corn/shared-types'
import { generateId } from '@corn/shared-utils'

export function registerQualityTools(server: McpServer, env: McpEnv) {
  // ─── Quality Report ──────────────────────────────────
  server.tool(
    'corn_quality_report',
    'Submit a quality report with 4-dimension scoring (Build, Regression, Standards, Traceability). Each dimension is 0-25, total 0-100.',
    {
      projectId: z.string().optional().describe('Project ID'),
      sessionId: z.string().optional().describe('Session ID'),
      gateName: z.string().describe('Quality gate name (e.g., "pre-commit", "post-task")'),
      scoreBuild: z.number().min(0).max(25).describe('Build quality (0-25)'),
      scoreRegression: z.number().min(0).max(25).describe('Regression check (0-25)'),
      scoreStandards: z.number().min(0).max(25).describe('Standards compliance (0-25)'),
      scoreTraceability: z.number().min(0).max(25).describe('Change traceability (0-25)'),
      details: z.string().optional().describe('Additional details as JSON'),
    },
    async ({ projectId, sessionId, gateName, scoreBuild, scoreRegression, scoreStandards, scoreTraceability, details }) => {
      const agentId = (env as McpEnv & { API_KEY_OWNER?: string }).API_KEY_OWNER || 'unknown'
      const reportId = generateId('qr')
      const total = scoreBuild + scoreRegression + scoreStandards + scoreTraceability

      // Calculate grade
      let grade: string
      if (total >= 90) grade = 'A'
      else if (total >= 75) grade = 'B'
      else if (total >= 60) grade = 'C'
      else if (total >= 40) grade = 'D'
      else grade = 'F'

      // Submit to Dashboard API
      try {
        const apiUrl = (env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')
        await fetch(`${apiUrl}/api/quality`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: reportId,
            projectId,
            agentId,
            sessionId,
            gateName,
            scoreBuild,
            scoreRegression,
            scoreStandards,
            scoreTraceability,
            scoreTotal: total,
            grade,
            passed: total >= 60,
            details: details ? JSON.parse(details) : null,
          }),
          signal: AbortSignal.timeout(5000),
        })
      } catch {
        // Best effort
      }

      const gradeEmoji = grade === 'A' ? '🏆' : grade === 'B' ? '✅' : grade === 'C' ? '⚠️' : grade === 'D' ? '⚠️' : '❌'

      return {
        content: [
          {
            type: 'text' as const,
            text: `${gradeEmoji} Quality Report: Grade ${grade} (${total}/100)\n\n` +
              `  Build:        ${scoreBuild}/25\n` +
              `  Regression:   ${scoreRegression}/25\n` +
              `  Standards:    ${scoreStandards}/25\n` +
              `  Traceability: ${scoreTraceability}/25\n\n` +
              `Gate: ${gateName} | ${total >= 60 ? 'PASSED ✅' : 'FAILED ❌'}`,
          },
        ],
      }
    },
  )

  // ─── Plan Quality ────────────────────────────────────
  server.tool(
    'corn_plan_quality',
    'Assess the quality of a plan before execution. Scores against 8 criteria: clarity, scope, risks, testing, reversibility, impact, dependencies, timeline.',
    {
      plan: z.string().describe('The plan text to assess'),
      projectId: z.string().optional().describe('Project context'),
    },
    async ({ plan, projectId }) => {
      // Simple heuristic scoring — in production, send to LLM for analysis
      const criteria = [
        { name: 'Clarity', check: plan.length > 50 },
        { name: 'Scope', check: plan.includes('file') || plan.includes('change') },
        { name: 'Risks', check: plan.toLowerCase().includes('risk') || plan.toLowerCase().includes('backup') },
        { name: 'Testing', check: plan.toLowerCase().includes('test') || plan.toLowerCase().includes('verify') },
        { name: 'Reversibility', check: plan.toLowerCase().includes('revert') || plan.toLowerCase().includes('rollback') },
        { name: 'Impact', check: plan.toLowerCase().includes('impact') || plan.toLowerCase().includes('affect') },
        { name: 'Dependencies', check: plan.toLowerCase().includes('depend') || plan.toLowerCase().includes('require') },
        { name: 'Timeline', check: plan.toLowerCase().includes('step') || plan.toLowerCase().includes('phase') },
      ]

      const scored = criteria.map((c) => ({
        ...c,
        score: c.check ? 10 : 3,
      }))

      const total = scored.reduce((sum, c) => sum + c.score, 0)
      const maxScore = criteria.length * 10
      const percentage = Math.round((total / maxScore) * 100)

      const formatted = scored
        .map((c) => `  ${c.score >= 7 ? '✅' : '⚠️'} ${c.name}: ${c.score}/10`)
        .join('\n')

      return {
        content: [
          {
            type: 'text' as const,
            text: `📋 Plan Quality Assessment: ${percentage}%\n\n${formatted}\n\nTotal: ${total}/${maxScore}\n\n${percentage >= 60 ? '✅ Plan looks good.' : '⚠️ Consider addressing the weak areas before proceeding.'}`,
          },
        ],
      }
    },
  )
}
