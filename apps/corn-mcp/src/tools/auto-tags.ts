// ─── Auto-tag for memory/knowledge (S7.2) ──────────────
// Two engines that share the same output shape:
//   - `heuristic`: tokenize content + stopword filter + frequency rank
//                  → top-N keyword tags. Pure JS, no IO.
//   - `llm`: chat completion that emits a JSON `{tags:[...]}` array of
//            3-7 semantic topic tags. Hardened against malformed
//            responses — anything that doesn't pass the schema check
//            throws so the dispatcher falls back to heuristic.
//
// Output is normalized through `validateAndDedupe` regardless of engine
// so callers always get lowercase, snake/kebab-friendly tags ≤ MAX_TAGS.

import {
  chatCompleteRemote,
  registerTask,
  type RunContext,
  type RemoteChatRequest,
} from '../services/task-dispatcher.js'

export interface AutoTagsInput {
  content: string
}

export interface AutoTagsResult {
  tags: string[]
}

export const AUTO_TAGS_TASK_NAME = 'auto_tags_for_memory'

/**
 * Register the auto-tags task with the dispatcher. Idempotent — safe to
 * call from multiple `register*Tools()` entry points (memory + knowledge).
 * Re-registering overwrites the previous handlers with identical refs,
 * so no behavior change.
 */
export function registerAutoTagsTask(): void {
  registerTask<AutoTagsInput, AutoTagsResult>(AUTO_TAGS_TASK_NAME, {
    heuristic: runHeuristic,
    llm: runLlm,
  })
}

// ── Validation rules (shared by heuristic + llm) ────────
const MIN_TAG_LEN = 3
const MAX_TAG_LEN = 30
const MAX_TAGS = 7
const TAG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

const STOPWORDS = new Set<string>([
  // English common
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did',
  'and', 'or', 'but', 'if', 'then', 'else', 'for', 'of', 'to', 'from',
  'with', 'without', 'in', 'on', 'at', 'by', 'as', 'it', 'its',
  'this', 'that', 'these', 'those',
  'i', 'you', 'he', 'she', 'we', 'they', 'them', 'my', 'your', 'his', 'her', 'our', 'their',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'will', 'would', 'could', 'should', 'can', 'may', 'might', 'must', 'shall',
  'not', 'no', 'yes', 'so', 'too', 'than', 'just', 'only', 'also', 'such',
  'one', 'two', 'three', 'first', 'second', 'next', 'last',
  // Vietnamese common (already-stripped diacritics will pass through too)
  'va', 'la', 'co', 'cua', 'cho', 'duoc', 'cac', 'nay', 'do', 'mot',
  'nhung', 'khi', 'neu', 'voi', 've', 'tu', 'vao', 'ra', 'len', 'xuong',
  'da', 'se', 'dang', 'hay', 'rat', 'nhu', 'thi', 'ma', 'hon',
  'cung', 'chi', 'van', 'nen', 'phai', 'trong', 'ngoai', 'tren', 'duoi',
  'sau', 'truoc',
])

/** Lowercase + dedupe + drop bad shapes + cap MAX_TAGS. Stable order: input order. */
export function validateAndDedupe(raw: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    if (typeof r !== 'string') continue
    // Normalize: lowercase, replace whitespace with `-`, strip surrounding junk.
    const t = r.trim().toLowerCase().replace(/\s+/g, '-').replace(/^[-_]+|[-_]+$/g, '')
    if (t.length < MIN_TAG_LEN || t.length > MAX_TAG_LEN) continue
    if (!TAG_PATTERN.test(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

// ── Heuristic engine ────────────────────────────────────

export function runHeuristic(input: AutoTagsInput): AutoTagsResult {
  const content = input?.content
  if (!content || typeof content !== 'string') return { tags: [] }

  // Match alphanumeric runs of 3-30 chars (token candidates). Underscore
  // and dash kept inside tokens but not as boundary anchors.
  const tokens = content.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,29}/g) ?? []

  const freq = new Map<string, number>()
  for (const tok of tokens) {
    if (STOPWORDS.has(tok)) continue
    // Drop pure-numeric tokens (years, ids) — rarely useful as tags.
    if (/^\d+$/.test(tok)) continue
    freq.set(tok, (freq.get(tok) ?? 0) + 1)
  }

  // Sort by freq desc, then alpha asc for stable output across runs.
  const ranked = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t)

  return { tags: validateAndDedupe(ranked) }
}

// ── LLM engine ──────────────────────────────────────────
// Prompt shape:
//   - System: extraction rules + JSON schema constraint.
//   - User:   the content (truncated to 8k chars to bound input cost).
// Output expected:
//   {"tags":["tag1","tag2","tag3"]}

const SYSTEM_PROMPT = [
  'You extract topic tags from the given text. Output ONLY a JSON object with this exact shape:',
  '{"tags":["tag1","tag2","tag3"]}',
  '',
  'Rules:',
  `- Return between 3 and ${MAX_TAGS} tags.`,
  `- Each tag is lowercase, ${MIN_TAG_LEN}-${MAX_TAG_LEN} chars, snake_case or kebab-case (alphanumerics + "_" or "-" only).`,
  '- No spaces, no punctuation other than "_" or "-".',
  '- Tags should name specific topics, technologies, project names, or features — not generic adjectives.',
  '- No prose, no code fences, no commentary.',
].join('\n')

export async function runLlm(input: AutoTagsInput, ctx: RunContext): Promise<AutoTagsResult> {
  const config = ctx.config
  if (config.engine !== 'llm') {
    throw new Error('runLlm called with non-llm config')
  }

  const content = input?.content ?? ''
  const model = config.model?.trim() || 'gpt-4o-mini'
  const promptOverride = config.prompt_template?.trim()
  // Bound the user prompt regardless of override to keep cost predictable.
  const truncated = content.slice(0, 8000)
  const userPrompt = promptOverride
    ? promptOverride.replace('{{content}}', truncated).replace('{{input}}', truncated)
    : `Text:\n\n${truncated}`

  const req: RemoteChatRequest = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    maxTokens: config.max_output_tokens || 256,
    temperature: typeof config.temperature === 'number' ? config.temperature : 0.2,
    timeoutMs: config.timeout_ms || 30_000,
    cacheTTLSec: config.cache_ttl_sec,
    taskName: 'auto_tags_for_memory',
  }
  if (config.provider_id) req.providerId = config.provider_id

  const resp = await chatCompleteRemote(req, ctx.env)
  const rawTags = parseLlmJson(resp.content)
  return { tags: validateAndDedupe(rawTags) }
}

/** Strip code fences, parse JSON, extract `tags` array of strings. Throws on schema violation. */
function parseLlmJson(content: string): string[] {
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
  const arr = (parsed as { tags?: unknown }).tags
  if (!Array.isArray(arr)) {
    throw new Error('LLM JSON missing or invalid `tags` array')
  }
  return arr.filter((x): x is string => typeof x === 'string')
}
