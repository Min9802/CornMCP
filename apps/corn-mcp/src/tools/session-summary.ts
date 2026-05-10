// ─── Session Summary (S7.3) ────────────────────────────
// Compress a long session log into 2-4 sentences for handoff. Two
// engines that share the same output shape:
//   - `heuristic`: sentence-aware truncation. Pure JS, no IO.
//                  Fits the first whole-sentence chunks under maxChars.
//                  Single very long sentence falls back to word-boundary
//                  truncation with ellipsis.
//   - `llm`:       chat completion that emits an abstractive summary
//                  (2-4 sentences, ≤400 chars). Output is plain text
//                  (no JSON), trimmed. Empty output throws so the
//                  dispatcher falls back to heuristic.

import {
  chatCompleteRemote,
  registerTask,
  type RunContext,
  type RemoteChatRequest,
} from '../services/task-dispatcher.js'

export interface SessionSummaryInput {
  text: string
  /** Max characters for the heuristic path. Defaults to 400. */
  maxChars?: number
}

export interface SessionSummaryResult {
  summary: string
}

export const SESSION_SUMMARY_TASK_NAME = 'session_summary'

export const DEFAULT_HEURISTIC_MAX_CHARS = 400

/**
 * Register the session-summary task with the dispatcher. Idempotent —
 * safe to call multiple times. Re-registering overwrites the previous
 * handlers with identical refs, so no behavior change.
 */
export function registerSessionSummaryTask(): void {
  registerTask<SessionSummaryInput, SessionSummaryResult>(SESSION_SUMMARY_TASK_NAME, {
    heuristic: runHeuristic,
    llm: runLlm,
  })
}

// ── Heuristic engine ────────────────────────────────────

export function runHeuristic(input: SessionSummaryInput): SessionSummaryResult {
  const trimmed = (input?.text ?? '').trim()
  const maxChars = input?.maxChars ?? DEFAULT_HEURISTIC_MAX_CHARS
  if (!trimmed) return { summary: '' }
  if (trimmed.length <= maxChars) return { summary: trimmed }

  // Sentence-aware split: keep terminal punctuation by using lookbehind.
  const sentences = trimmed.split(/(?<=[.!?…])\s+/).filter((s) => s.trim().length > 0)

  let acc = ''
  for (const s of sentences) {
    const next = acc ? `${acc} ${s}` : s
    if (next.length > maxChars) break
    acc = next
  }
  if (acc) return { summary: acc }

  // Single very long sentence — hard truncate at word boundary.
  const cut = trimmed.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  const base = lastSpace > 0 ? cut.slice(0, lastSpace) : cut
  return { summary: `${base.trimEnd()}…` }
}

// ── LLM engine ──────────────────────────────────────────

const SYSTEM_PROMPT = [
  'You summarize a session log into 2-4 concise sentences for handoff to a future agent.',
  '',
  'Rules:',
  '- Keep the summary under 400 characters total.',
  '- Mention the main task accomplished, key decisions, and any blockers or next steps.',
  '- Use the same language as the input (Vietnamese if the input is Vietnamese, English otherwise).',
  '- Output ONLY the summary text — no JSON, no markdown, no code fences, no preamble like "Summary:".',
].join('\n')

export async function runLlm(
  input: SessionSummaryInput,
  ctx: RunContext,
): Promise<SessionSummaryResult> {
  const config = ctx.config
  if (config.engine !== 'llm') {
    throw new Error('runLlm called with non-llm config')
  }

  const text = (input?.text ?? '').trim()
  const model = config.model?.trim() || 'gpt-4o-mini'
  const promptOverride = config.prompt_template?.trim()
  // Bound the user prompt to keep cost predictable. 8k chars ≈ 2k tokens
  // upper bound — the gateway's max_input_tokens takes precedence anyway.
  const truncated = text.slice(0, 8000)
  const userPrompt = promptOverride
    ? promptOverride.replace('{{text}}', truncated).replace('{{input}}', truncated)
    : `Session log:\n\n${truncated}`

  const req: RemoteChatRequest = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    maxTokens: config.max_output_tokens || 400,
    temperature: typeof config.temperature === 'number' ? config.temperature : 0.3,
    timeoutMs: config.timeout_ms || 30_000,
    cacheTTLSec: config.cache_ttl_sec,
    taskName: SESSION_SUMMARY_TASK_NAME,
  }
  if (config.provider_id) req.providerId = config.provider_id

  const resp = await chatCompleteRemote(req, ctx.env)
  const summary = (resp.content ?? '').trim()
  if (!summary) {
    throw new Error('LLM returned empty summary')
  }
  return { summary }
}
