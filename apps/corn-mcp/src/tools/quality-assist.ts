// ─── Quality Report Assist (S7.4) ───────────────────────
// Auto-fill the 4-dimension quality scores (Build, Regression, Standards,
// Traceability) used by `corn_quality_report` from free-form change
// context (git diff summary, changed files, test output, session
// summary). Two engines that share the same output shape:
//   - `heuristic`: rule-based scoring using file-path / keyword heuristics.
//                  Pure JS, no IO. Conservative defaults so a change with
//                  no supporting signals lands around 60/100 (C-grade) —
//                  agent must supply evidence to push scores higher.
//   - `llm`:       chat completion that rates each dimension 0-25 with
//                  a JSON schema. Output is parsed + clamped. A missing
//                  dimension falls back to the heuristic's default for
//                  that dimension instead of throwing, mirroring the
//                  `plan_quality` "soft-fail" pattern.
//
// The tool `corn_quality_report_assist` is ADVISORY — it returns suggested
// scores + reasoning so an agent can preview and then call the existing
// `corn_quality_report` with the numbers (or adjust them). Wiring a
// separate tool (rather than extending corn_quality_report) keeps the
// submit-to-DB path untouched and zero-regression.

import {
  chatCompleteRemote,
  registerTask,
  type RunContext,
  type RemoteChatRequest,
} from '../services/task-dispatcher.js'

export interface QualityAssistInput {
  /** Git diff text or human-written diff summary. Optional. */
  gitDiff?: string
  /** List of changed file paths (relative). Used to detect test files. Optional. */
  changedFiles?: string[]
  /** Test runner output or summary (e.g. "20/20 PASS"). Optional. */
  testResults?: string
  /** Session / commit / PR summary written by the agent. Optional. */
  summary?: string
  /** Extra free-form reasoning the agent wants to submit with the report. Optional. */
  agentReasoning?: string
}

export interface QualityAssistResult {
  scoreBuild: number
  scoreRegression: number
  scoreStandards: number
  scoreTraceability: number
  /** 1-3 sentence rationale. Plain text, no markdown. */
  reasoning: string
}

export const QUALITY_ASSIST_TASK_NAME = 'quality_report_assist'

/** Exported so the UI / tests can show the same ordering as the submit tool. */
export const DIMENSIONS = [
  { key: 'scoreBuild', label: 'Build Quality' },
  { key: 'scoreRegression', label: 'Regression Check' },
  { key: 'scoreStandards', label: 'Standards Compliance' },
  { key: 'scoreTraceability', label: 'Change Traceability' },
] as const

const MAX_DIM_SCORE = 25

/**
 * Register the quality-assist task with the dispatcher. Idempotent —
 * safe to call multiple times. Re-registering overwrites the previous
 * handlers with identical refs, so no behavior change.
 */
export function registerQualityAssistTask(): void {
  registerTask<QualityAssistInput, QualityAssistResult>(QUALITY_ASSIST_TASK_NAME, {
    heuristic: runHeuristic,
    llm: runLlm,
  })
}

// ── Heuristic engine ────────────────────────────────────
// Scoring rubric (each dimension starts at a neutral default then gets
// nudged by signals present / absent in the input). All scores clamped
// to [0, 25] at the end. No dimension can be pushed to 25 without at
// least one positive signal — heuristic should reward evidence, not
// reward the agent for submitting no context at all.

function clamp(n: number, lo = 0, hi = MAX_DIM_SCORE): number {
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

function hasAny(hay: string, needles: string[]): boolean {
  const lower = hay.toLowerCase()
  return needles.some((n) => lower.includes(n.toLowerCase()))
}

function countTestFiles(files: string[]): number {
  return files.filter(
    (f) =>
      /\.(test|spec)\.[a-z0-9]+$/i.test(f) ||
      /(^|[\\/])tests?[\\/]/i.test(f) ||
      /(^|[\\/])__tests__[\\/]/i.test(f),
  ).length
}

interface HeuristicSignals {
  totalFiles: number
  testFiles: number
  nonTestFiles: number
  testsPassed: boolean
  testsFailed: boolean
  summaryLen: number
  summaryHasIssueRef: boolean
  summaryHasFilePath: boolean
  mentionsLintClean: boolean
  mentionsTypecheckPass: boolean
  mentionsBroken: boolean
  diffHasTodo: boolean
  diffLargeChurn: boolean
}

function collectSignals(input: QualityAssistInput): HeuristicSignals {
  const files = Array.isArray(input.changedFiles) ? input.changedFiles.filter((f) => typeof f === 'string') : []
  const testFiles = countTestFiles(files)
  const nonTestFiles = Math.max(0, files.length - testFiles)

  const testResults = (input.testResults ?? '').trim()
  const summary = (input.summary ?? '').trim()
  const reasoning = (input.agentReasoning ?? '').trim()
  const diff = (input.gitDiff ?? '').trim()

  // Normalize all text we'll search into one lower-case blob for keyword
  // checks. Keep the original `summary` / `diff` around for length-based
  // checks so lowercasing doesn't mutate byte counts.
  const text = [summary, reasoning, testResults, diff].join('\n')

  const testsPassed =
    hasAny(testResults, ['pass', ' ok', 'ok.', 'passing']) &&
    !hasAny(testResults, ['fail', 'error'])
  const testsFailed = hasAny(testResults, ['fail', 'error', 'broken', 'crash'])

  return {
    totalFiles: files.length,
    testFiles,
    nonTestFiles,
    testsPassed,
    testsFailed,
    summaryLen: summary.length,
    summaryHasIssueRef: /(#\d+|closes\s+#|fixes\s+#|resolves\s+#)/i.test(summary),
    summaryHasFilePath: /@[\w./\\-]+:\d+/.test(summary) || /`[\w./\\-]+\.[a-z]{1,5}`/i.test(summary),
    mentionsLintClean: hasAny(text, ['lint clean', 'no warnings', 'no lint', 'eslint pass', 'zero warnings']),
    mentionsTypecheckPass: hasAny(text, ['typecheck pass', 'type check pass', 'tsc pass', 'typecheck ok', 'no type errors']),
    mentionsBroken: hasAny(text, ['broken', 'does not compile', 'build fail', 'build broken']),
    diffHasTodo: /\bTODO\b|\bFIXME\b|\bXXX\b/.test(diff),
    diffLargeChurn: diff.length > 20_000,
  }
}

export function runHeuristic(input: QualityAssistInput): QualityAssistResult {
  const s = collectSignals(input ?? {})
  const hasContext = s.totalFiles > 0 || s.summaryLen > 0 || (input?.gitDiff ?? '').length > 0

  // With zero context the assist has nothing to grade. Return low scores
  // + explicit reasoning so the agent sees the "provide more evidence"
  // signal instead of a middling 60/100 that could pass a quality gate.
  if (!hasContext) {
    return {
      scoreBuild: 10,
      scoreRegression: 8,
      scoreStandards: 12,
      scoreTraceability: 6,
      reasoning:
        'No change context supplied (no files, no summary, no diff). Provide changedFiles, summary, or gitDiff for a meaningful score.',
    }
  }

  // ── scoreBuild ────────────────────────────────────────
  // Default 15 (neutral). Explicit pass → 22. Explicit fail → 5.
  // Mentions of "broken" in summary pulls down hard.
  let build = 15
  if (s.testsPassed) build = 22
  else if (s.testsFailed) build = 5
  if (s.mentionsBroken) build -= 6
  if (s.mentionsTypecheckPass) build += 3

  // ── scoreRegression ───────────────────────────────────
  // Default 10 (no tests = concerning). Each test file touched adds
  // +4, capped at +14 (3+ test files). Explicit "N/N PASS" style pattern
  // adds a small bonus. Coverage mention adds +3.
  let regression = 10
  regression += Math.min(14, s.testFiles * 4)
  if (/\b\d+\s*\/\s*\d+\s+PASS\b/i.test(input?.testResults ?? '')) regression += 3
  if (hasAny((input?.summary ?? '') + '\n' + (input?.agentReasoning ?? ''), ['coverage', 'regression test'])) {
    regression += 3
  }
  // No tests touched at all on a non-trivial change drags it down.
  if (s.testFiles === 0 && s.nonTestFiles >= 3) regression -= 4

  // ── scoreStandards ────────────────────────────────────
  // Default 18 (assume conventions followed unless signal says otherwise).
  let standards = 18
  if (s.mentionsLintClean) standards += 4
  if (s.mentionsTypecheckPass) standards += 2
  if (s.diffHasTodo) standards -= 3
  if (s.diffLargeChurn) standards -= 2 // >20k diff = likely missed review lens

  // ── scoreTraceability ─────────────────────────────────
  // Default 12. Summary length is the biggest lever — clear writeups earn
  // points. Issue refs + file citations add small bonuses.
  let traceability = 12
  if (s.summaryLen >= 80) traceability += 4
  if (s.summaryLen >= 200) traceability += 3
  if (s.summaryLen >= 500) traceability += 2
  if (s.summaryHasIssueRef) traceability += 3
  if (s.summaryHasFilePath) traceability += 2

  const scoreBuild = clamp(build)
  const scoreRegression = clamp(regression)
  const scoreStandards = clamp(standards)
  const scoreTraceability = clamp(traceability)

  // Build a short rationale from the strongest signals. Keep it under
  // ~200 chars so the tool output stays compact.
  const notes: string[] = []
  if (s.testsPassed) notes.push('tests passing')
  if (s.testsFailed) notes.push('tests failing')
  if (s.mentionsBroken) notes.push('broken build mentioned')
  if (s.testFiles > 0) notes.push(`${s.testFiles} test file(s) changed`)
  else if (s.nonTestFiles >= 3) notes.push('code changed but no tests touched')
  if (s.mentionsLintClean) notes.push('lint clean')
  if (s.mentionsTypecheckPass) notes.push('typecheck passing')
  if (s.summaryLen >= 200) notes.push('detailed summary')
  else if (s.summaryLen < 80 && s.summaryLen > 0) notes.push('short summary')
  else if (s.summaryLen === 0) notes.push('no summary')
  if (s.summaryHasIssueRef) notes.push('issue referenced')

  const reasoning = notes.length
    ? `Heuristic signals: ${notes.join(', ')}.`
    : 'Heuristic used default scores — no strong signals detected in the supplied context.'

  return { scoreBuild, scoreRegression, scoreStandards, scoreTraceability, reasoning }
}

// ── LLM engine ──────────────────────────────────────────
// Prompt shape mirrors plan-quality's structure-output approach:
//   - System: scoring rubric + strict JSON schema + clamp rules.
//   - User:   the context assembled as labeled sections.
// Expected output:
//   {"scoreBuild":N,"scoreRegression":N,"scoreStandards":N,
//    "scoreTraceability":N,"reasoning":"..."}
//
// Parse logic clamps scores into [0, 25], coerces non-numbers via the
// heuristic's default for that dimension, and rejects only when the root
// JSON itself is malformed. Missing reasoning → empty string (tool
// layer renders "LLM provided no reasoning").

const SYSTEM_PROMPT = [
  'You are a code-review quality assistant. Given context about a code change, rate it on 4 dimensions. Each dimension is an integer from 0 to 25.',
  '',
  'Dimensions:',
  '1. Build Quality — compiles, builds, no obvious type/syntax errors.',
  '2. Regression Check — tests added or updated, coverage preserved, no obvious regressions.',
  '3. Standards Compliance — follows coding conventions, lint clean, types OK, no TODOs left behind.',
  '4. Change Traceability — clear summary, narrow scope, issue linked if applicable, file citations where relevant.',
  '',
  'Output STRICT JSON with exactly these keys:',
  '{"scoreBuild":N,"scoreRegression":N,"scoreStandards":N,"scoreTraceability":N,"reasoning":"1-2 sentences"}',
  '',
  'Rules:',
  '- Each score is an INTEGER in [0, 25]. Clamp out-of-range values.',
  '- `reasoning` is 1-3 short sentences of plain text. No markdown, no bullet lists.',
  '- Output ONLY the JSON object. No code fences, no commentary, no preamble.',
].join('\n')

function buildUserPrompt(input: QualityAssistInput): string {
  const parts: string[] = []
  const summary = (input.summary ?? '').trim()
  const diff = (input.gitDiff ?? '').trim()
  const files = Array.isArray(input.changedFiles)
    ? input.changedFiles.filter((f) => typeof f === 'string')
    : []
  const testResults = (input.testResults ?? '').trim()
  const reasoning = (input.agentReasoning ?? '').trim()

  if (summary) parts.push(`Summary:\n${summary.slice(0, 2000)}`)
  if (files.length)
    parts.push(`Changed files (${files.length}):\n${files.slice(0, 50).join('\n')}`)
  if (testResults) parts.push(`Test results:\n${testResults.slice(0, 1000)}`)
  if (reasoning) parts.push(`Agent reasoning:\n${reasoning.slice(0, 1000)}`)
  // Diff last — typically the biggest blob, truncate aggressively.
  if (diff) parts.push(`Git diff (truncated):\n${diff.slice(0, 4000)}`)

  // If nothing useful was supplied, hand the model a minimal note so it
  // doesn't hallucinate a perfect score on an empty input.
  if (parts.length === 0) {
    parts.push('No change context supplied.')
  }
  return parts.join('\n\n')
}

export async function runLlm(
  input: QualityAssistInput,
  ctx: RunContext,
): Promise<QualityAssistResult> {
  const config = ctx.config
  if (config.engine !== 'llm') {
    throw new Error('runLlm called with non-llm config')
  }

  const model = config.model?.trim() || 'gpt-4o-mini'
  const promptOverride = config.prompt_template?.trim()
  const userContent = buildUserPrompt(input ?? {})
  const userPrompt = promptOverride
    ? promptOverride.replace('{{input}}', userContent).replace('{{context}}', userContent)
    : userContent

  const req: RemoteChatRequest = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    maxTokens: config.max_output_tokens || 600,
    temperature: typeof config.temperature === 'number' ? config.temperature : 0.2,
    timeoutMs: config.timeout_ms || 30_000,
    cacheTTLSec: config.cache_ttl_sec,
    taskName: QUALITY_ASSIST_TASK_NAME,
  }
  if (config.provider_id) req.providerId = config.provider_id

  const resp = await chatCompleteRemote(req, ctx.env)
  return parseLlmJson(resp.content, input ?? {})
}

/**
 * Strip code fences, parse JSON, coerce + clamp each dimension.
 * Missing / invalid numeric fields fall back to the heuristic default
 * for that dimension (soft-fail) rather than throwing, so a partially-
 * compliant LLM response still gives a usable result. Only throws when
 * the response is not valid JSON at all or is not an object — those are
 * protocol-level failures the dispatcher should fall back on.
 */
export function parseLlmJson(
  content: string,
  inputForFallback: QualityAssistInput,
): QualityAssistResult {
  const trimmed = (content ?? '').trim()
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

  const obj = parsed as Record<string, unknown>

  // Heuristic fallback is computed lazily — only when at least one
  // dimension is missing from the LLM output.
  let fallback: QualityAssistResult | null = null
  const getFallback = (): QualityAssistResult => {
    if (!fallback) fallback = runHeuristic(inputForFallback)
    return fallback
  }

  const coerce = (raw: unknown, fallbackVal: number): number => {
    if (typeof raw === 'number' && Number.isFinite(raw)) return clamp(raw)
    if (typeof raw === 'string') {
      const n = Number(raw)
      if (Number.isFinite(n)) return clamp(n)
    }
    return clamp(fallbackVal)
  }

  const scoreBuild = coerce(obj['scoreBuild'], getFallback().scoreBuild)
  const scoreRegression = coerce(obj['scoreRegression'], getFallback().scoreRegression)
  const scoreStandards = coerce(obj['scoreStandards'], getFallback().scoreStandards)
  const scoreTraceability = coerce(obj['scoreTraceability'], getFallback().scoreTraceability)

  const reasoningRaw = obj['reasoning']
  const reasoning =
    typeof reasoningRaw === 'string' && reasoningRaw.trim().length
      ? reasoningRaw.trim().slice(0, 600)
      : ''

  return { scoreBuild, scoreRegression, scoreStandards, scoreTraceability, reasoning }
}
