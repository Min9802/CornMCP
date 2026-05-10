// ─── Dedup (S7.5 memory_dedup + S7.9 knowledge_dedup) ──
// Shared heuristic + llm implementation used by two task names:
//   - `memory_dedup`   — registered from `memory.ts` pre-store
//   - `knowledge_dedup` — registered from `knowledge.ts` pre-store
//
// The caller is expected to do a vector-similarity search first and
// pass the top-K candidates + the incoming content to the task. The
// task decides whether the incoming item is effectively a duplicate
// of one of the candidates.
//
// Two engines that share the same output shape:
//   - `heuristic`: top-candidate score ≥ threshold → duplicate.
//                  Pure function of the search scores the caller
//                  already computed. No extra IO.
//   - `llm`:       chat completion that judges semantic equivalence,
//                  returns JSON `{isDuplicate, duplicateOfId, reason}`.
//                  Strict JSON parse; missing / malformed → throws so
//                  the dispatcher falls back to heuristic.
//
// Best-effort wiring: callers wrap `runTask()` in try/catch. Any
// failure (registry mis-config, both engines failing) → skip dedup,
// store the item. Better to write a duplicate than to drop a legit
// memory.

import {
  chatCompleteRemote,
  registerTask,
  type RunContext,
  type RemoteChatRequest,
} from '../services/task-dispatcher.js'

export interface DedupCandidate {
  /** Vector-store id of the existing item. */
  id: string
  /** Existing content to compare against. May be truncated. */
  content: string
  /** Similarity score from the caller's vector search (higher = more similar). */
  score: number
}

export interface DedupInput {
  /** The new incoming content that might be a duplicate. */
  content: string
  /** Top-K similar existing items the caller pre-fetched. */
  candidates: DedupCandidate[]
  /**
   * Heuristic threshold — top candidate score ≥ this ⇒ duplicate.
   * Defaults to 0.92 which is strict on 1024-dim embeddings.
   */
  threshold?: number
}

export interface DedupResult {
  isDuplicate: boolean
  /** Set when isDuplicate=true and a specific candidate was matched. */
  duplicateOfId?: string
  /** Short human-readable rationale. Optional. */
  reason?: string
}

export const MEMORY_DEDUP_TASK_NAME = 'memory_dedup'
export const KNOWLEDGE_DEDUP_TASK_NAME = 'knowledge_dedup'

/** Default similarity threshold for the heuristic engine. */
export const DEFAULT_DEDUP_THRESHOLD = 0.92

/**
 * Register both dedup tasks with the dispatcher. Idempotent — the
 * memory + knowledge tool modules both call this during their
 * `register*Tools()` entry point. Last write wins with identical
 * refs, so order does not matter.
 */
export function registerDedupTasks(): void {
  registerTask<DedupInput, DedupResult>(MEMORY_DEDUP_TASK_NAME, {
    heuristic: runHeuristic,
    llm: runLlm,
  })
  registerTask<DedupInput, DedupResult>(KNOWLEDGE_DEDUP_TASK_NAME, {
    heuristic: runHeuristic,
    llm: runLlm,
  })
}

// ── Heuristic engine ────────────────────────────────────

export function runHeuristic(input: DedupInput): DedupResult {
  const candidates = Array.isArray(input?.candidates) ? input.candidates : []
  if (candidates.length === 0) {
    return { isDuplicate: false, reason: 'no candidates supplied' }
  }

  const threshold =
    typeof input.threshold === 'number' && Number.isFinite(input.threshold)
      ? input.threshold
      : DEFAULT_DEDUP_THRESHOLD

  // Find the highest-score candidate. Ignore malformed entries silently.
  let top: DedupCandidate | null = null
  for (const c of candidates) {
    if (!c || typeof c.score !== 'number' || !Number.isFinite(c.score)) continue
    if (!top || c.score > top.score) top = c
  }

  if (!top) {
    return { isDuplicate: false, reason: 'no scored candidates' }
  }

  if (top.score >= threshold) {
    return {
      isDuplicate: true,
      duplicateOfId: top.id,
      reason: `top candidate score ${top.score.toFixed(3)} ≥ threshold ${threshold}`,
    }
  }

  return {
    isDuplicate: false,
    reason: `top candidate score ${top.score.toFixed(3)} < threshold ${threshold}`,
  }
}

// ── LLM engine ──────────────────────────────────────────
// Prompt shape mirrors auto-tags / plan-quality:
//   - System: rules + strict JSON schema.
//   - User:   incoming content + candidate list labeled with [id].
// Expected output:
//   {"isDuplicate":true/false,"duplicateOfId":"<id>","reason":"..."}
//
// Parse logic coerces missing `isDuplicate` into false (soft-fail —
// better to write a duplicate than lose a legit memory). Non-JSON
// response throws so the dispatcher can fall back to heuristic.

const SYSTEM_PROMPT = [
  'You judge whether a new text is semantically duplicate of one of the existing candidates.',
  '',
  'Output STRICT JSON with exactly these keys:',
  '{"isDuplicate":true|false,"duplicateOfId":"<candidate id or empty>","reason":"1 short sentence"}',
  '',
  'Rules:',
  '- Two texts are DUPLICATES when they describe the same fact/event/decision, even with different wording.',
  '- Paraphrases, translations, and minor reordering → DUPLICATE.',
  '- Two items about the same topic but different facts → NOT duplicate.',
  '- If isDuplicate=false, set duplicateOfId to an empty string.',
  '- Output ONLY the JSON object. No code fences, no commentary.',
].join('\n')

function buildUserPrompt(input: DedupInput): string {
  const incoming = (input?.content ?? '').slice(0, 4000)
  const candidates = (Array.isArray(input?.candidates) ? input.candidates : []).slice(0, 5)

  const candidateBlock = candidates
    .map(
      (c, i) =>
        `Candidate ${i + 1} [id=${c?.id ?? '<unknown>'}, score=${typeof c?.score === 'number' ? c.score.toFixed(3) : 'n/a'}]:\n${(c?.content ?? '').slice(0, 1500)}`,
    )
    .join('\n\n---\n\n')

  return [
    `New item:\n${incoming}`,
    '',
    `Existing candidates (${candidates.length}):`,
    candidateBlock || '<none>',
  ].join('\n')
}

export async function runLlm(input: DedupInput, ctx: RunContext): Promise<DedupResult> {
  const config = ctx.config
  if (config.engine !== 'llm') {
    throw new Error('runLlm called with non-llm config')
  }

  // No candidates → short-circuit without burning tokens.
  if (!Array.isArray(input?.candidates) || input.candidates.length === 0) {
    return { isDuplicate: false, reason: 'no candidates supplied' }
  }

  const model = config.model?.trim() || 'gpt-4o-mini'
  const promptOverride = config.prompt_template?.trim()
  const userContent = buildUserPrompt(input)
  const userPrompt = promptOverride
    ? promptOverride.replace('{{input}}', userContent).replace('{{context}}', userContent)
    : userContent

  const req: RemoteChatRequest = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    maxTokens: config.max_output_tokens || 256,
    temperature: typeof config.temperature === 'number' ? config.temperature : 0.1,
    timeoutMs: config.timeout_ms || 30_000,
    cacheTTLSec: config.cache_ttl_sec,
    taskName: MEMORY_DEDUP_TASK_NAME,
  }
  if (config.provider_id) req.providerId = config.provider_id

  const resp = await chatCompleteRemote(req, ctx.env)
  return parseLlmJson(resp.content, input)
}

/**
 * Strip code fences, parse JSON, coerce fields. Missing `isDuplicate`
 * collapses to `false` (safer to allow a write than silently drop
 * content). `duplicateOfId` is only honored when one of the
 * candidate ids matches — hallucinated ids are dropped.
 */
export function parseLlmJson(content: string, input: DedupInput): DedupResult {
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

  const isDuplicate = obj['isDuplicate'] === true || obj['isDuplicate'] === 'true'

  const candidateIds = new Set(
    (Array.isArray(input?.candidates) ? input.candidates : [])
      .map((c) => c?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )

  const rawId = typeof obj['duplicateOfId'] === 'string' ? obj['duplicateOfId'].trim() : ''
  const duplicateOfId = isDuplicate && rawId && candidateIds.has(rawId) ? rawId : undefined

  // If the model said duplicate but gave a hallucinated / empty id we
  // keep isDuplicate but drop the id. Callers can still decide what to
  // do; typically they skip the store and log a warning.
  const reasoning = typeof obj['reason'] === 'string' ? obj['reason'].trim().slice(0, 400) : ''
  const reason = reasoning || (isDuplicate ? 'LLM flagged duplicate' : 'LLM says unique')

  return duplicateOfId !== undefined
    ? { isDuplicate: true, duplicateOfId, reason }
    : { isDuplicate, reason }
}
