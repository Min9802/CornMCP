// ─── LLM Gateway HTTP proxy (S5.4 task-dispatcher consumer) ──────
// corn-mcp is a separate process so it can't import the in-process
// `chatComplete()` from the gateway module directly. This thin proxy
// authenticates the caller (any API key OR admin JWT) and forwards
// the ChatRequest / ChatResponse 1:1.
//
// Error mapping:
//   - CostCapExceeded         → HTTP 402 (Payment Required) — semantically
//                              closest to "budget hit" and stable for clients.
//   - ProviderAuth            → 502 (Bad Gateway, upstream auth)
//   - ProviderRateLimit       → 429 (with Retry-After header when known)
//   - ProviderTimeout         → 504
//   - ProviderError 5xx       → 502
//   - NoProviderConfigured    → 503 Service Unavailable
//   - LLMGatewayError generic → 500
//
// The dispatcher (corn-mcp/services/task-dispatcher.ts) reads the JSON
// `error.code` field to decide whether to fall back to heuristic; it
// does NOT re-walk the gateway fallback chain (that's the gateway's
// job, already exhausted at this point).

import { Hono } from 'hono'
import { anyAuthMiddleware, jwtAuthMiddleware, adminOnly } from '../middleware/auth.js'
import {
  chatComplete,
  type ChatRequest,
  type Message,
  CostCapExceededError,
  NoProviderConfiguredError,
  ProviderAuthError,
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  LLMGatewayError,
} from '../services/llm-gateway/index.js'
import { getLlmStats, getCostCapStatus } from '../services/llm-stats.js'

export const llmRouter = new Hono()
llmRouter.use('*', anyAuthMiddleware)

function isMessage(x: unknown): x is Message {
  if (!x || typeof x !== 'object') return false
  const m = x as Record<string, unknown>
  return (
    (m['role'] === 'system' || m['role'] === 'user' || m['role'] === 'assistant') &&
    typeof m['content'] === 'string'
  )
}

interface ErrorEnvelope {
  error: string
  code: string
  detail?: string | number | undefined
}

llmRouter.post('/chat-complete', async (c) => {
  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json<ErrorEnvelope>(
      { error: 'Invalid JSON body', code: 'invalid_request' },
      400,
    )
  }

  const messages = body['messages']
  if (!Array.isArray(messages) || messages.length === 0 || !messages.every(isMessage)) {
    return c.json<ErrorEnvelope>(
      { error: '`messages` must be a non-empty array of {role, content}', code: 'invalid_request' },
      400,
    )
  }

  const model = body['model']
  if (typeof model !== 'string' || model.trim() === '') {
    return c.json<ErrorEnvelope>(
      { error: '`model` is required', code: 'invalid_request' },
      400,
    )
  }

  const req: ChatRequest = {
    model,
    messages: messages as Message[],
  }
  if (typeof body['providerId'] === 'string') req.providerId = body['providerId']
  if (body['provider'] === 'openai' || body['provider'] === 'anthropic' || body['provider'] === 'gemini') {
    req.provider = body['provider']
  }
  if (typeof body['maxTokens'] === 'number') req.maxTokens = body['maxTokens']
  if (typeof body['temperature'] === 'number') req.temperature = body['temperature']
  if (typeof body['timeoutMs'] === 'number') req.timeoutMs = body['timeoutMs']
  if (typeof body['cacheTTLSec'] === 'number') req.cacheTTLSec = body['cacheTTLSec']
  if (typeof body['taskName'] === 'string') req.taskName = body['taskName']
  if (typeof body['userId'] === 'string') req.userId = body['userId']
  if (typeof body['sessionId'] === 'string') req.sessionId = body['sessionId']

  try {
    const response = await chatComplete(req)
    return c.json(response)
  } catch (err) {
    if (err instanceof CostCapExceededError) {
      return c.json<ErrorEnvelope>(
        { error: err.message, code: 'cost_cap_exceeded', detail: err.spentUsd },
        402,
      )
    }
    if (err instanceof NoProviderConfiguredError) {
      return c.json<ErrorEnvelope>(
        { error: err.message, code: 'no_provider_configured' },
        503,
      )
    }
    if (err instanceof ProviderRateLimitError) {
      if (err.retryAfterSec) c.header('Retry-After', String(err.retryAfterSec))
      return c.json<ErrorEnvelope>(
        { error: err.message, code: 'rate_limited', detail: err.retryAfterSec },
        429,
      )
    }
    if (err instanceof ProviderTimeoutError) {
      return c.json<ErrorEnvelope>(
        { error: err.message, code: 'timeout', detail: err.timeoutMs },
        504,
      )
    }
    if (err instanceof ProviderAuthError) {
      return c.json<ErrorEnvelope>({ error: err.message, code: 'provider_auth' }, 502)
    }
    if (err instanceof ProviderError) {
      return c.json<ErrorEnvelope>(
        { error: err.message, code: 'provider_error', detail: err.statusCode },
        502,
      )
    }
    if (err instanceof LLMGatewayError) {
      return c.json<ErrorEnvelope>({ error: err.message, code: 'gateway_error' }, 500)
    }
    return c.json<ErrorEnvelope>(
      { error: (err as Error).message ?? 'Unknown error', code: 'internal' },
      500,
    )
  }
})

// ─── Admin-only analytics (S6.1 / S6.4) ─────────────────
// Cost dashboard widget reads `/stats` for the rolling N-day window
// and `/cost-cap-status` for the live spent vs cap percentage. Both
// are read-only; mutations to the cap go through `/api/system/settings`
// (key=`llm.cost_cap_usd_per_day`).
//
// Mounted as a separate sub-router so JWT+admin guard does not collide
// with the anyAuth mount on `/chat-complete` — corn-mcp dispatches with
// an API key, admin UI uses the JWT cookie.
export const llmAdminRouter = new Hono()
llmAdminRouter.use('*', jwtAuthMiddleware)
llmAdminRouter.use('*', adminOnly)

llmAdminRouter.get('/stats', async (c) => {
  // Param sanitization happens inside `getLlmStats` (clamped 1..90).
  // Don't pre-coerce here so the service can express its own contract.
  const days = c.req.query('days')
  const stats = await getLlmStats(Number(days) || 1)
  return c.json(stats)
})

llmAdminRouter.get('/cost-cap-status', async (c) => {
  const status = await getCostCapStatus()
  return c.json(status)
})
