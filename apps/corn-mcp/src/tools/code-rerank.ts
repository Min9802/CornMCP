// ─── Code Search Rerank (S7.6) ─────────────────────────
// Rerank a list of code search hits by relevance to the query. Two
// engines sharing the same output shape:
//   - `heuristic`: stable sort by the caller-supplied `score` (descending).
//                  Items without a score keep their input order at the
//                  bottom. No IO.
//   - `llm`:       chat completion that re-scores each item 0-1 with a
//                  JSON schema keyed by id. Missing items keep their
//                  heuristic order (soft-fail per item).
//
// Designed as an ADVISORY task: the agent calls the companion MCP tool
// `corn_code_rerank` with the raw hits returned from `corn_code_search`
// (or any other source). No implicit wire into corn_code_search since
// the upstream endpoint currently only returns a pre-formatted markdown
// blob — reranking a string would lose structure. When the upstream
// adds structured output this task can be plugged in transparently.

import {
  chatCompleteRemote,
  registerTask,
  type RunContext,
  type RemoteChatRequest,
} from '../services/task-dispatcher.js'

export interface CodeRerankItem {
  /** Unique id (file:line, symbol, or opaque handle supplied by caller). */
  id: string
  /** Code / text snippet to judge relevance on. Truncated internally. */
  snippet: string
  /** Optional upstream score the caller already produced (e.g. vector similarity). */
  score?: number
}

export interface CodeRerankInput {
  /** Natural-language intent from the agent / user. */
  query: string
  /** Items to rerank. Order is preserved unless the engine changes it. */
  items: CodeRerankItem[]
  /** Cap number of items the llm will rerank to bound cost. Default 10. */
  topK?: number
}

export interface CodeRerankOutputItem {
  id: string
  score: number
  /** Only populated by the llm engine; heuristic leaves it undefined. */
  reason?: string
}

export interface CodeRerankResult {
  items: CodeRerankOutputItem[]
}

export const CODE_RERANK_TASK_NAME = 'code_search_rerank'

/** Default cap on the number of items the LLM is asked to rerank. */
export const DEFAULT_TOP_K = 10

/** Register the rerank task. Idempotent across repeat calls. */
export function registerCodeRerankTask(): void {
  registerTask<CodeRerankInput, CodeRerankResult>(CODE_RERANK_TASK_NAME, {
    heuristic: runHeuristic,
    llm: runLlm,
  })
}

// ── Heuristic engine ────────────────────────────────────

export function runHeuristic(input: CodeRerankInput): CodeRerankResult {
  const items = Array.isArray(input?.items) ? input.items : []
  if (items.length === 0) return { items: [] }

  // Preserve input order (stable) but sort primary by score desc when
  // present. Items without a score drop to the end in original order.
  // We tag each entry with its input index so the comparator can break
  // ties deterministically.
  const decorated = items
    .filter((it) => it && typeof it.id === 'string' && it.id.length > 0)
    .map((it, idx) => ({ it, idx }))

  decorated.sort((a, b) => {
    const sa = typeof a.it.score === 'number' && Number.isFinite(a.it.score) ? a.it.score : -Infinity
    const sb = typeof b.it.score === 'number' && Number.isFinite(b.it.score) ? b.it.score : -Infinity
    if (sb !== sa) return sb - sa
    return a.idx - b.idx
  })

  return {
    items: decorated.map(({ it }) => ({
      id: it.id,
      score: typeof it.score === 'number' && Number.isFinite(it.score) ? it.score : 0,
    })),
  }
}

// ── LLM engine ──────────────────────────────────────────

const SYSTEM_PROMPT = [
  'You rerank code search results by relevance to the user query.',
  '',
  'Output STRICT JSON with exactly this shape:',
  '{"items":[{"id":"<same id as input>","score":<0..1>,"reason":"one short sentence"}]}',
  '',
  'Rules:',
  '- `score` is a float in [0, 1] where 1 means perfectly relevant.',
  '- Include an item in the output for EVERY id from the input. Do not invent new ids.',
  '- Keep reasons short (≤120 chars). No markdown, no code fences.',
  '- Output ONLY the JSON object.',
].join('\n')

function buildUserPrompt(input: CodeRerankInput, topK: number): string {
  const query = (input.query ?? '').trim().slice(0, 2000)
  const items = (Array.isArray(input.items) ? input.items : []).slice(0, topK)
  const block = items
    .map(
      (it, i) =>
        `Item ${i + 1} [id=${it?.id ?? '<unknown>'}, upstreamScore=${typeof it?.score === 'number' ? it.score.toFixed(3) : 'n/a'}]:\n${(it?.snippet ?? '').slice(0, 1500)}`,
    )
    .join('\n\n---\n\n')

  return `Query:\n${query}\n\nCandidates (${items.length}):\n${block}`
}

export async function runLlm(input: CodeRerankInput, ctx: RunContext): Promise<CodeRerankResult> {
  const config = ctx.config
  if (config.engine !== 'llm') {
    throw new Error('runLlm called with non-llm config')
  }

  const items = Array.isArray(input?.items) ? input.items : []
  if (items.length === 0) return { items: [] }

  const topK =
    typeof input.topK === 'number' && input.topK > 0 && input.topK <= 50 ? input.topK : DEFAULT_TOP_K
  const toRerank = items.slice(0, topK)
  const remainder = items.slice(topK)

  const model = config.model?.trim() || 'gpt-4o-mini'
  const promptOverride = config.prompt_template?.trim()
  const userContent = buildUserPrompt({ ...input, items: toRerank }, topK)
  const userPrompt = promptOverride
    ? promptOverride.replace('{{input}}', userContent).replace('{{context}}', userContent)
    : userContent

  const req: RemoteChatRequest = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    maxTokens: config.max_output_tokens || 512,
    temperature: typeof config.temperature === 'number' ? config.temperature : 0.1,
    timeoutMs: config.timeout_ms || 30_000,
    cacheTTLSec: config.cache_ttl_sec,
    taskName: CODE_RERANK_TASK_NAME,
  }
  if (config.provider_id) req.providerId = config.provider_id

  const resp = await chatCompleteRemote(req, ctx.env)
  const reranked = parseLlmJson(resp.content, toRerank)

  // Append leftover items (beyond topK) verbatim at the tail with their
  // upstream score so the final array covers every input id.
  return {
    items: [
      ...reranked,
      ...remainder.map((it) => ({
        id: it.id,
        score: typeof it.score === 'number' && Number.isFinite(it.score) ? it.score : 0,
      })),
    ],
  }
}

/**
 * Parse the LLM's JSON and produce a clean list. Every input id MUST
 * appear in the output — ids the model omitted fall back to their
 * upstream score (soft-fail). Hallucinated ids are dropped.
 */
export function parseLlmJson(content: string, originalItems: CodeRerankItem[]): CodeRerankOutputItem[] {
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
  const arr = (parsed as { items?: unknown }).items
  if (!Array.isArray(arr)) {
    throw new Error('LLM JSON missing or invalid `items` array')
  }

  const validIds = new Set(originalItems.map((it) => it.id))
  const seen = new Set<string>()
  const llmOut = new Map<string, CodeRerankOutputItem>()

  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>
    const id = typeof obj['id'] === 'string' ? obj['id'] : ''
    if (!id || !validIds.has(id) || seen.has(id)) continue
    seen.add(id)

    const rawScore = obj['score']
    let score = 0
    if (typeof rawScore === 'number' && Number.isFinite(rawScore)) {
      score = rawScore
    } else if (typeof rawScore === 'string') {
      const n = Number(rawScore)
      score = Number.isFinite(n) ? n : 0
    }
    score = Math.max(0, Math.min(1, score))

    const reasoning = typeof obj['reason'] === 'string' ? obj['reason'].trim().slice(0, 240) : ''
    const entry: CodeRerankOutputItem = reasoning ? { id, score, reason: reasoning } : { id, score }
    llmOut.set(id, entry)
  }

  // Fold in any original items the LLM omitted, preserving their
  // upstream score but placing them after the LLM-scored items.
  const ordered: CodeRerankOutputItem[] = []
  for (const id of seen) {
    const hit = llmOut.get(id)
    if (hit) ordered.push(hit)
  }
  // Sort LLM-scored items by score desc so the caller sees the rerank.
  ordered.sort((a, b) => b.score - a.score)

  const missing = originalItems.filter((it) => !seen.has(it.id))
  for (const it of missing) {
    ordered.push({
      id: it.id,
      score: typeof it.score === 'number' && Number.isFinite(it.score) ? it.score : 0,
    })
  }

  return ordered
}
