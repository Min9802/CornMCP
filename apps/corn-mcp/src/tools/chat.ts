// ─── Chat Assistant (S7.10) ────────────────────────────
// Free-form chat completion that lives inside the MCP transport.
// Unlike the other S7 tasks this one has NO meaningful heuristic
// fallback — a chat without an LLM is a no-op. The heuristic path
// therefore throws `ChatHeuristicUnsupportedError` with guidance so
// the agent sees the correct remediation (flip the engine in admin
// UI, supply a provider key).
//
// Call flow:
//   agent → corn_chat (new MCP tool in advisory.ts)
//         → runTask('chat_assistant', {messages, systemPrompt?})
//           ├─ engine='heuristic' → throw (user sees guidance)
//           └─ engine='llm' → chatCompleteRemote → trimmed content
//
// Scope: single-turn or short multi-turn, non-streaming. MCP transport
// uses enableJsonResponse=true so we don't surface token-by-token
// deltas today (TOKEN_PLAN P14 tracks streaming separately).

import {
  chatCompleteRemote,
  registerTask,
  type RunContext,
  type RemoteChatRequest,
} from '../services/task-dispatcher.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatInput {
  messages: ChatMessage[]
  /** Optional top-level system prompt prepended if no system message is present. */
  systemPrompt?: string
}

export interface ChatResult {
  content: string
  /** Counts surfaced from the gateway so the tool UI can show cost. */
  inputTokens: number
  outputTokens: number
  costUsd: number
  model: string
  cached: boolean
}

export const CHAT_ASSISTANT_TASK_NAME = 'chat_assistant'

/** Thrown by the heuristic path — chat without LLM is unsupported. */
export class ChatHeuristicUnsupportedError extends Error {
  constructor() {
    super(
      'chat_assistant has no heuristic engine. Switch to engine=llm in admin UI (Task Engines → chat_assistant) and configure a provider.',
    )
    this.name = 'ChatHeuristicUnsupportedError'
  }
}

/** Register the chat task. Idempotent. */
export function registerChatTask(): void {
  registerTask<ChatInput, ChatResult>(CHAT_ASSISTANT_TASK_NAME, {
    heuristic: runHeuristic,
    llm: runLlm,
  })
}

// ── Heuristic engine ────────────────────────────────────
// Heuristic has no useful behavior for free-form chat. We surface
// actionable guidance via a custom error so the dispatcher's
// fallback_to_heuristic path produces a helpful message instead of a
// bare heuristic string.

export function runHeuristic(_input: ChatInput): ChatResult {
  throw new ChatHeuristicUnsupportedError()
}

// ── Validators ──────────────────────────────────────────

function sanitizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return []
  const out: ChatMessage[] = []
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue
    const obj = m as Record<string, unknown>
    const role = obj['role']
    const content = obj['content']
    if (role !== 'system' && role !== 'user' && role !== 'assistant') continue
    if (typeof content !== 'string' || content.length === 0) continue
    out.push({ role, content })
  }
  return out
}

// ── LLM engine ──────────────────────────────────────────

export async function runLlm(input: ChatInput, ctx: RunContext): Promise<ChatResult> {
  const config = ctx.config
  if (config.engine !== 'llm') {
    throw new Error('runLlm called with non-llm config')
  }

  const messages = sanitizeMessages(input?.messages)
  if (messages.length === 0) {
    throw new Error('chat_assistant: messages array is empty or malformed')
  }

  // Inject a system prompt if none provided. Prefer explicit user
  // override (`systemPrompt`) over task-level default.
  const hasSystem = messages[0]?.role === 'system'
  const finalMessages: ChatMessage[] = hasSystem
    ? messages
    : input.systemPrompt
    ? [{ role: 'system', content: input.systemPrompt.slice(0, 4000) }, ...messages]
    : messages

  const model = config.model?.trim() || 'gpt-4o-mini'
  // No prompt_template substitution here — the caller already shapes
  // the messages array. Task prompt_template field is unused for chat
  // (it's a reminder slot for the admin UI).

  const req: RemoteChatRequest = {
    model,
    messages: finalMessages,
    maxTokens: config.max_output_tokens || 1024,
    temperature: typeof config.temperature === 'number' ? config.temperature : 0.3,
    timeoutMs: config.timeout_ms || 60_000,
    cacheTTLSec: config.cache_ttl_sec,
    taskName: CHAT_ASSISTANT_TASK_NAME,
  }
  if (config.provider_id) req.providerId = config.provider_id

  const resp = await chatCompleteRemote(req, ctx.env)
  const content = (resp.content ?? '').trim()
  if (!content) {
    throw new Error('chat_assistant: LLM returned empty content')
  }
  return {
    content,
    inputTokens: resp.inputTokens,
    outputTokens: resp.outputTokens,
    costUsd: resp.costUsd,
    model: resp.model,
    cached: resp.cached,
  }
}
