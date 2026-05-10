import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpEnv } from '@corn/shared-types'
import { generateId } from '@corn/shared-utils'
import { registerTask, runTask } from '../services/task-dispatcher.js'
import { runHeuristic, runLlm, type PlanQualityResult } from './plan-quality.js'
import {
  registerQualityAssistTask,
  QUALITY_ASSIST_TASK_NAME,
  type QualityAssistInput,
  type QualityAssistResult,
} from './quality-assist.js'

function apiHeaders(env: McpEnv): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.DASHBOARD_API_KEY) h['X-API-Key'] = env.DASHBOARD_API_KEY
  return h
}

/** Build a visual bar: ████████░░ (filled vs empty blocks, max width) */
function scoreBar(score: number, max: number, width = 10): string {
  const filled = Math.round((score / max) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** Map a 0-100 total to a letter grade + emoji */
function gradeInfo(total: number): { grade: string; emoji: string; label: string } {
  if (total >= 90) return { grade: 'A', emoji: '🏆', label: 'Excellent' }
  if (total >= 75) return { grade: 'B', emoji: '✅', label: 'Good' }
  if (total >= 60) return { grade: 'C', emoji: '⚠️', label: 'Acceptable' }
  if (total >= 40) return { grade: 'D', emoji: '🟡', label: 'Needs Work' }
  return { grade: 'F', emoji: '❌', label: 'Failing' }
}

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
      const { grade, emoji, label } = gradeInfo(total)
      const passed = total >= 60

      // Submit to Dashboard API (best-effort with diagnostic logging).
      try {
        const apiUrl = (env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')
        const res = await fetch(`${apiUrl}/api/quality`, {
          method: 'POST',
          headers: apiHeaders(env),
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
            passed,
            details: details ? JSON.parse(details) : null,
          }),
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) {
          const body = await res.text().catch(() => '<unreadable>')
          console.warn(
            `[corn-mcp] dashboard sync /api/quality HTTP ${res.status} (id=${reportId}, project=${projectId || 'none'}): ${body.slice(0, 200)}`,
          )
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[corn-mcp] dashboard sync /api/quality network error (id=${reportId}): ${msg}`)
      }

      // ── Build rich table output ──
      const dimensions = [
        { name: 'Build Quality', score: scoreBuild },
        { name: 'Regression Check', score: scoreRegression },
        { name: 'Standards Compliance', score: scoreStandards },
        { name: 'Change Traceability', score: scoreTraceability },
      ]

      // Identify weak dimensions (below 60%)
      const weakDimensions = dimensions.filter(d => Math.round((d.score / 25) * 100) < 60)

      const lines: string[] = []

      lines.push(`## ${emoji} Quality Report — Grade ${grade} (${label})`)
      lines.push('')
      lines.push(`| Gate | Total Score | Grade | Status |`)
      lines.push(`|:-----|:----------:|:-----:|:------:|`)
      lines.push(`| ${gateName} | **${total}/100** | **${grade}** | ${passed ? '✅ PASSED' : '❌ FAILED'} |`)
      lines.push('')
      lines.push(`### Score Breakdown`)
      lines.push('')
      lines.push(`| Dimension | Score | Bar | Rating |`)
      lines.push(`|:----------|------:|:----|:------:|`)
      for (const d of dimensions) {
        const pct = Math.round((d.score / 25) * 100)
        const rating = pct >= 80 ? '🟢' : pct >= 60 ? '🟡' : '🔴'
        lines.push(`| ${d.name} | **${d.score}**/25 | \`${scoreBar(d.score, 25)}\` | ${rating} ${pct}% |`)
      }
      lines.push('')
      lines.push(`> **Report ID:** \`${reportId}\` · **Agent:** \`${agentId}\`${projectId ? ` · **Project:** \`${projectId}\`` : ''}`)

      // ── QUALITY GATE ENFORCEMENT ──
      if (!passed) {
        lines.push('')
        lines.push(`---`)
        lines.push(`## 🚫 QUALITY GATE FAILED — DO NOT PROCEED`)
        lines.push('')
        lines.push(`**Score ${total}/100 is below the required threshold of 60/100.**`)
        lines.push('')
        if (weakDimensions.length > 0) {
          lines.push(`### Failing Dimensions:`)
          for (const d of weakDimensions) {
            lines.push(`- ❌ **${d.name}**: ${d.score}/25 (${Math.round((d.score / 25) * 100)}%)`)
          }
          lines.push('')
        }
        lines.push(`**MANDATORY:** You MUST stop, fix the failing dimensions above, and resubmit this quality report before continuing with any further work. Do NOT commit, push, or deploy until this gate passes.`)
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: !passed,
      }
    },
  )

  // ─── Plan Quality ────────────────────────────────────
  const PLAN_QUALITY_THRESHOLD = 80

  // Register the task with the dispatcher exactly once per process. The
  // heuristic handler is the legacy keyword scorer; the LLM handler
  // sends the plan through the gateway with a structured-output prompt.
  // Engine selection (heuristic vs llm) and fallback policy live in DB
  // (`task_engine_config`) so admin can flip without redeploy.
  registerTask<{ plan: string }, PlanQualityResult>('plan_quality', {
    heuristic: ({ plan }) => runHeuristic(plan),
    llm: async ({ plan }, ctx) => runLlm(plan, ctx),
  })

  server.tool(
    'corn_plan_quality',
    'Assess the quality of a plan before execution. Scores against 8 criteria: clarity, scope, risks, testing, reversibility, impact, dependencies, timeline. Plans MUST score ≥80% to proceed.',
    {
      plan: z.string().describe('The plan text to assess'),
      projectId: z.string().optional().describe('Project context'),
    },
    async ({ plan }) => {
      const { result, metadata } = await runTask<{ plan: string }, PlanQualityResult>(
        'plan_quality',
        { plan },
        env as McpEnv,
      )

      const scored = result.criteria
      const { total, maxScore, percentage, passedCount } = result
      const failedCriteria = scored.filter((c) => c.score < 7)
      const meetsThreshold = percentage >= PLAN_QUALITY_THRESHOLD
      const { grade, emoji, label } = gradeInfo(percentage)

      const lines: string[] = []

      lines.push(`## 📋 Plan Quality Assessment — Grade ${grade}`)
      lines.push('')
      // Surface the engine that produced the score so an agent can tell
      // whether the assessment came from heuristic vs LLM, and whether
      // an LLM error caused a fallback.
      const engineBadge = metadata.engineUsed === 'llm' ? '🤖 LLM' : '⚙️ Heuristic'
      const fallbackNote = metadata.fellBack ? ` _(fell back from LLM: ${metadata.llmError ?? 'unknown error'})_` : ''
      lines.push(`> Engine: **${engineBadge}**${fallbackNote}`)
      lines.push('')
      lines.push(`| Overall Score | Grade | Criteria Passed | Threshold | Status |`)
      lines.push(`|:------------:|:-----:|:---------------:|:---------:|:------:|`)
      lines.push(`| **${percentage}%** (${total}/${maxScore}) | ${emoji} **${grade}** — ${label} | ${passedCount}/${scored.length} | ${PLAN_QUALITY_THRESHOLD}% | ${meetsThreshold ? '✅ APPROVED' : '🚫 REJECTED'} |`)
      lines.push('')
      lines.push(`### Criteria Breakdown`)
      lines.push('')
      lines.push(`| # | Criteria | Score | Bar | Status | Hint / Reason |`)
      lines.push(`|:-:|:---------|------:|:----|:------:|:-----|`)
      scored.forEach((c, i) => {
        const status = c.score >= 7 ? '✅ Pass' : '❌ Fail'
        // LLM path supplies a justification; heuristic path uses the hint
        // when the criterion failed. Pass criteria show '—'.
        const note = c.reason ?? (c.score >= 7 ? '—' : c.hint)
        lines.push(`| ${i + 1} | ${c.icon} ${c.name} | **${c.score}**/10 | \`${scoreBar(c.score, 10, 8)}\` | ${status} | ${note} |`)
      })
      lines.push('')

      if (!meetsThreshold) {
        // ── HARD ENFORCEMENT: PLAN REJECTED ──
        lines.push(`---`)
        lines.push(`## 🚫 PLAN REJECTED — SCORE ${percentage}% IS BELOW ${PLAN_QUALITY_THRESHOLD}% THRESHOLD`)
        lines.push('')
        lines.push(`**Your plan failed ${failedCriteria.length} criteria. You MUST revise it before executing.**`)
        lines.push('')
        lines.push(`### ❌ Missing from your plan:`)
        lines.push('')
        for (const c of failedCriteria) {
          lines.push(`${c.icon} **${c.name}** — ${c.hint}`)
        }
        lines.push('')
        lines.push(`### 📝 Required Action:`)
        lines.push(`1. **STOP** — Do NOT execute this plan`)
        lines.push(`2. **REVISE** — Rewrite your plan addressing every ❌ criteria above`)
        lines.push(`3. **RESUBMIT** — Call \`corn_plan_quality\` again with the improved plan`)
        lines.push(`4. **ONLY proceed** when the score is ≥${PLAN_QUALITY_THRESHOLD}%`)
        lines.push('')
        lines.push(`> 🛑 **This is a mandatory quality gate. Executing a rejected plan violates project quality standards.**`)
      } else {
        lines.push(`> ✅ **Plan approved** — meets the ${PLAN_QUALITY_THRESHOLD}% quality threshold. Safe to proceed with execution.`)
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: !meetsThreshold,
      }
    },
  )

  // ─── Quality Report Assist (S7.4) ────────────────────
  // Advisory tool: takes free-form change context and returns SUGGESTED
  // scores for the 4 quality dimensions so an agent can preview before
  // calling `corn_quality_report` with hand-picked numbers. This tool
  // never submits to the DB — keeping the submit path unchanged means
  // S7.4 is zero-regression to the existing quality-gate flow.
  registerQualityAssistTask()

  server.tool(
    'corn_quality_report_assist',
    'Suggest scores for corn_quality_report 4 dimensions (Build/Regression/Standards/Traceability) from change context (git diff, changed files, test output, summary). Advisory only — does NOT submit a quality report. Review the output, adjust if needed, then call corn_quality_report with the final scores.',
    {
      summary: z.string().optional().describe('Session/commit/PR summary (what changed and why)'),
      changedFiles: z.array(z.string()).optional().describe('Relative paths of modified files'),
      testResults: z.string().optional().describe('Test runner output or summary (e.g. "20/20 PASS")'),
      gitDiff: z.string().optional().describe('Git diff text (will be truncated internally)'),
      agentReasoning: z.string().optional().describe('Extra reasoning the agent wants the model to consider'),
    },
    async ({ summary, changedFiles, testResults, gitDiff, agentReasoning }) => {
      const { result, metadata } = await runTask<QualityAssistInput, QualityAssistResult>(
        QUALITY_ASSIST_TASK_NAME,
        { summary, changedFiles, testResults, gitDiff, agentReasoning },
        env as McpEnv,
      )

      const total =
        result.scoreBuild + result.scoreRegression + result.scoreStandards + result.scoreTraceability
      const { grade, emoji, label } = gradeInfo(total)
      const passed = total >= 60

      const engineBadge = metadata.engineUsed === 'llm' ? '🤖 LLM' : '⚙️ Heuristic'
      const fallbackNote = metadata.fellBack
        ? ` _(fell back from LLM: ${metadata.llmError ?? 'unknown error'})_`
        : ''

      const dimensions = [
        { name: 'Build Quality', score: result.scoreBuild, key: 'scoreBuild' },
        { name: 'Regression Check', score: result.scoreRegression, key: 'scoreRegression' },
        { name: 'Standards Compliance', score: result.scoreStandards, key: 'scoreStandards' },
        { name: 'Change Traceability', score: result.scoreTraceability, key: 'scoreTraceability' },
      ]

      const lines: string[] = []
      lines.push(`## 🔍 Quality Report — Suggested Scores (${engineBadge})${fallbackNote}`)
      lines.push('')
      lines.push(`> **Advisory only** — this tool does NOT submit a quality report. Review the scores below, adjust if needed, then call \`corn_quality_report\` with the final numbers.`)
      lines.push('')
      lines.push(`| Suggested Total | Grade | Meets 60/100 gate? |`)
      lines.push(`|:---------------:|:-----:|:------------------:|`)
      lines.push(`| **${total}/100** | ${emoji} ${grade} — ${label} | ${passed ? '✅ Yes' : '❌ No'} |`)
      lines.push('')
      lines.push(`### Suggested Breakdown`)
      lines.push('')
      lines.push(`| Dimension | Score | Bar | Rating |`)
      lines.push(`|:----------|------:|:----|:------:|`)
      for (const d of dimensions) {
        const pct = Math.round((d.score / 25) * 100)
        const rating = pct >= 80 ? '🟢' : pct >= 60 ? '🟡' : '🔴'
        lines.push(`| ${d.name} | **${d.score}**/25 | \`${scoreBar(d.score, 25)}\` | ${rating} ${pct}% |`)
      }
      lines.push('')
      if (result.reasoning) {
        lines.push(`### Reasoning`)
        lines.push('')
        lines.push(`> ${result.reasoning}`)
        lines.push('')
      }
      lines.push(`### Next step — submit the report`)
      lines.push('')
      lines.push('```json')
      lines.push(
        JSON.stringify(
          {
            scoreBuild: result.scoreBuild,
            scoreRegression: result.scoreRegression,
            scoreStandards: result.scoreStandards,
            scoreTraceability: result.scoreTraceability,
          },
          null,
          2,
        ),
      )
      lines.push('```')
      lines.push('')
      lines.push(
        `Copy the JSON above into a \`corn_quality_report\` call with a \`gateName\` (e.g. \`"post-task"\`) and optional \`details\`. Adjust scores first if you disagree with the assessment.`,
      )

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      }
    },
  )
}
