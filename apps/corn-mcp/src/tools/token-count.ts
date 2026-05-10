// ─── Token Count (S7.8) ────────────────────────────────
// Estimate token count for a text blob with two engines:
//   - `heuristic`: local approximation = ceil(len / 4) with a CJK
//                  adjustment (each non-ASCII char counts 1.5× more
//                  because BPE vocab rarely covers them efficiently).
//                  Pure function, no IO.
//   - `llm`:       prompt-based fallback — asks the model to count the
//                  BPE tokens in a short snippet and reply with ONLY
//                  an integer. Useful for provider-specific tokenizers
//                  that the local heuristic can't approximate (Chinese,
//                  code with long symbol names, etc.). Bounded input
//                  (8k chars) so the call itself stays cheap.
//
// Intended callers: telemetry / cost-estimation paths that want a
// ballpark without shipping a full BPE tokenizer. The heuristic is the
// default. Flip engine='llm' in admin UI when accuracy matters more
// than latency.

import {
  chatCompleteRemote,
  registerTask,
  type RunContext,
  type RemoteChatRequest,
} from '../services/task-dispatcher.js'

export interface TokenCountInput {
  text: string
  /** Provider model the caller cares about (e.g. "gpt-4o-mini"). Optional. */
  model?: string
}

export interface TokenCountResult {
  tokens: number
  /** Which path produced the count. */
  method: 'heuristic' | 'llm'
  /** Echoed back for the UI. */
  model?: string
}

export const TOKEN_COUNT_TASK_NAME = 'token_count'

/** Register the token-count task. Idempotent. */
export function registerTokenCountTask(): void {
  registerTask<TokenCountInput, TokenCountResult>(TOKEN_COUNT_TASK_NAME, {
    heuristic: runHeuristic,
    llm: runLlm,
  })
}

// ── Heuristic engine ────────────────────────────────────
// Two passes: ASCII chars ≈ 4 per token; non-ASCII ≈ 1.5 chars per
// token (BPE vocab for CJK expands badly, so 1 char = ~0.67 tokens).
// Empty input → 0.

export function runHeuristic(input: TokenCountInput): TokenCountResult {
  const text = input?.text ?? ''
  if (!text) return { tokens: 0, method: 'heuristic', model: input?.model }

  let asciiChars = 0
  let nonAsciiChars = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) asciiChars++
    else nonAsciiChars++
  }
  const tokens = Math.ceil(asciiChars / 4 + nonAsciiChars / 1.5)
  return { tokens, method: 'heuristic', model: input?.model }
}

// ── LLM engine ──────────────────────────────────────────

const SYSTEM_PROMPT = [
  'You estimate BPE token counts for the provided text.',
  'Reply with ONLY a single non-negative integer — no units, no commentary, no JSON, no code fence.',
  'If unsure, return a conservative estimate.',
].join('\n')

/**
 * Parse the LLM response into a non-negative integer. Anything that
 * isn't a finite non-negative integer throws → dispatcher falls back
 * to heuristic.
 */
export function parseLlmInt(content: string): number {
  const trimmed = (content ?? '').trim()
  // Grab the first run of digits. Accepts "123" / "123 tokens" / "~123".
  const match = trimmed.match(/\d+/)
  if (!match) {
    throw new Error(`LLM did not return a number: ${trimmed.slice(0, 120)}`)
  }
  const n = Number(match[0])
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`LLM returned invalid integer: ${match[0]}`)
  }
  return Math.round(n)
}

export async function runLlm(input: TokenCountInput, ctx: RunContext): Promise<TokenCountResult> {
  const config = ctx.config
  if (config.engine !== 'llm') {
    throw new Error('runLlm called with non-llm config')
  }

  const text = (input?.text ?? '').slice(0, 8000)
  if (!text) return { tokens: 0, method: 'llm', model: input?.model }

  const model = config.model?.trim() || input?.model?.trim() || 'gpt-4o-mini'
  const promptOverride = config.prompt_template?.trim()
  const userPrompt = promptOverride
    ? promptOverride.replace('{{text}}', text).replace('{{input}}', text)
    : `Count BPE tokens for this text (target model: ${input?.model ?? 'unspecified'}):\n\n${text}`

  const req: RemoteChatRequest = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    maxTokens: config.max_output_tokens || 64,
    temperature: typeof config.temperature === 'number' ? config.temperature : 0,
    timeoutMs: config.timeout_ms || 30_000,
    cacheTTLSec: config.cache_ttl_sec,
    taskName: TOKEN_COUNT_TASK_NAME,
  }
  if (config.provider_id) req.providerId = config.provider_id

  const resp = await chatCompleteRemote(req, ctx.env)
  const tokens = parseLlmInt(resp.content)
  return { tokens, method: 'llm', model: input?.model ?? model }
}
