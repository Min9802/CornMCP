// ─── Plan Quality scoring (S5.3) ────────────────────────
// Two engines that share the same output shape:
//   - `heuristic`: keyword/length checks → 0-10 per criterion (legacy logic).
//   - `llm`: chat completion that scores each criterion 0-10 with a short
//            justification (JSON output). Hardened against malformed
//            responses — anything that doesn't pass the schema check
//            throws so the dispatcher falls back to heuristic.
//
// Both paths return `PlanQualityResult` so the MCP tool wrapper can
// render a single Markdown report regardless of which engine ran.

import {
  chatCompleteRemote,
  type RunContext,
  type RemoteChatRequest,
} from '../services/task-dispatcher.js'

export interface PlanCriterionScore {
  name: string
  icon: string
  score: number
  hint: string
  reason?: string
}

export interface PlanQualityResult {
  criteria: PlanCriterionScore[]
  total: number
  maxScore: number
  percentage: number
  passedCount: number
}

// ── Static criterion table (shared) ─────────────────────
// Heuristic path uses .check; LLM path uses .name + .hint to build the
// rubric prompt. Keep order stable — the JSON output schema indexes by
// position so a reordering would silently break parsing.
interface HeuristicCriterion {
  name: string
  icon: string
  hint: string
  /** Heuristic check returns true → score 10, false → score 3. */
  check: (plan: string) => boolean
}

export const PLAN_CRITERIA: readonly HeuristicCriterion[] = [
  {
    name: 'Clarity',
    icon: '📝',
    hint: 'Plan should be detailed (>50 chars)',
    check: (p) => p.length > 50,
  },
  {
    name: 'Scope',
    icon: '🎯',
    hint: 'Mention specific files or changes to make',
    check: (p) => p.includes('file') || p.includes('change'),
  },
  {
    name: 'Risks',
    icon: '⚡',
    hint: 'Address potential risks or backup strategy',
    check: (p) => {
      const l = p.toLowerCase()
      return l.includes('risk') || l.includes('backup')
    },
  },
  {
    name: 'Testing',
    icon: '🧪',
    hint: 'Include test/verification steps',
    check: (p) => {
      const l = p.toLowerCase()
      return l.includes('test') || l.includes('verify')
    },
  },
  {
    name: 'Reversibility',
    icon: '↩️',
    hint: 'Describe rollback strategy if something goes wrong',
    check: (p) => {
      const l = p.toLowerCase()
      return l.includes('revert') || l.includes('rollback')
    },
  },
  {
    name: 'Impact',
    icon: '💥',
    hint: 'Describe what downstream systems or users are affected',
    check: (p) => {
      const l = p.toLowerCase()
      return l.includes('impact') || l.includes('affect')
    },
  },
  {
    name: 'Dependencies',
    icon: '🔗',
    hint: 'List what this plan depends on or requires',
    check: (p) => {
      const l = p.toLowerCase()
      return l.includes('depend') || l.includes('require')
    },
  },
  {
    name: 'Timeline',
    icon: '📅',
    hint: 'Break into numbered steps or phases',
    check: (p) => {
      const l = p.toLowerCase()
      return l.includes('step') || l.includes('phase')
    },
  },
] as const

const MAX_PER_CRITERION = 10

function summarize(scores: PlanCriterionScore[]): PlanQualityResult {
  const total = scores.reduce((sum, c) => sum + c.score, 0)
  const maxScore = scores.length * MAX_PER_CRITERION
  const percentage = Math.round((total / maxScore) * 100)
  const passedCount = scores.filter((c) => c.score >= 7).length
  return { criteria: scores, total, maxScore, percentage, passedCount }
}

// ── Heuristic engine ────────────────────────────────────

export function runHeuristic(plan: string): PlanQualityResult {
  const scores: PlanCriterionScore[] = PLAN_CRITERIA.map((c) => ({
    name: c.name,
    icon: c.icon,
    hint: c.hint,
    score: c.check(plan) ? 10 : 3,
  }))
  return summarize(scores)
}

// ── LLM engine ──────────────────────────────────────────
// Prompt shape:
//   - System: rubric + JSON schema constraint.
//   - User:   plan text.
// Output:
//   {"scores": [{"name":"Clarity","score":<0-10>,"reason":"<short>"}, ...]}
//
// We accept a few common drift modes (reason missing, score as string,
// extra criteria) and clamp to [0,10]. Anything beyond that is a parse
// failure → throws → dispatcher falls back to heuristic.

const SYSTEM_PROMPT = [
  'You are a strict plan-quality reviewer. Given a plan, score it on 8 criteria below.',
  'Each criterion gets an integer score 0-10 and a single-sentence reason citing the plan text.',
  '',
  'Criteria (in order, names must match exactly):',
  ...PLAN_CRITERIA.map((c, i) => `${i + 1}. ${c.name} — ${c.hint}`),
  '',
  'Output ONLY a JSON object with this exact shape (no prose, no code fences):',
  '{"scores":[{"name":"Clarity","score":7,"reason":"…"}, …]}',
  'The "scores" array MUST contain exactly 8 entries in the same order as the criteria above.',
].join('\n')

interface LlmScoreEntry {
  name: string
  score: number
  reason?: string
}

function parseLlmJson(content: string): LlmScoreEntry[] {
  // Strip code fences if a model adds them despite instructions.
  const trimmed = content.trim()
  let jsonText = trimmed
  if (trimmed.startsWith('```')) {
    const firstNewline = trimmed.indexOf('\n')
    const fenceClose = trimmed.lastIndexOf('```')
    if (firstNewline > 0 && fenceClose > firstNewline) {
      jsonText = trimmed.slice(firstNewline + 1, fenceClose).trim()
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw new Error(`LLM response was not valid JSON: ${trimmed.slice(0, 200)}`)
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('LLM JSON missing root object')
  }
  const arr = (parsed as { scores?: unknown }).scores
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('LLM JSON missing or empty `scores` array')
  }
  return arr.map((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`scores[${idx}] is not an object`)
    }
    const e = entry as Record<string, unknown>
    const name = typeof e['name'] === 'string' ? (e['name'] as string) : ''
    const rawScore = e['score']
    let score = typeof rawScore === 'number' ? rawScore : Number(rawScore)
    if (!Number.isFinite(score)) {
      throw new Error(`scores[${idx}].score is not a number`)
    }
    score = Math.max(0, Math.min(10, Math.round(score)))
    const reason = typeof e['reason'] === 'string' ? (e['reason'] as string) : undefined
    return { name, score, reason }
  })
}

export async function runLlm(plan: string, ctx: RunContext): Promise<PlanQualityResult> {
  const config = ctx.config
  if (config.engine !== 'llm') {
    throw new Error('runLlm called with non-llm config')
  }

  const model = config.model?.trim() || 'gpt-4o-mini'
  const promptOverride = config.prompt_template?.trim()
  const userPrompt = promptOverride
    ? promptOverride.replace('{{plan}}', plan)
    : `Plan to review:\n\n${plan}`

  const req: RemoteChatRequest = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    maxTokens: config.max_output_tokens || 800,
    temperature: typeof config.temperature === 'number' ? config.temperature : 0.2,
    timeoutMs: config.timeout_ms || 30_000,
    cacheTTLSec: config.cache_ttl_sec,
    taskName: 'plan_quality',
  }
  if (config.provider_id) req.providerId = config.provider_id

  const resp = await chatCompleteRemote(req, ctx.env)
  const entries = parseLlmJson(resp.content)

  // Match LLM-returned scores back to the canonical PLAN_CRITERIA order
  // by `name` (case-insensitive). Any criterion the LLM omitted gets a
  // zero — surfaces the gap to the admin instead of inflating.
  const scores: PlanCriterionScore[] = PLAN_CRITERIA.map((c) => {
    const match = entries.find((e) => e.name.toLowerCase() === c.name.toLowerCase())
    if (!match) {
      return { name: c.name, icon: c.icon, hint: c.hint, score: 0, reason: 'LLM omitted this criterion' }
    }
    return {
      name: c.name,
      icon: c.icon,
      hint: c.hint,
      score: match.score,
      reason: match.reason,
    }
  })

  return summarize(scores)
}
