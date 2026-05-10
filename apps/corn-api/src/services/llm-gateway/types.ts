// ─── LLM Gateway — Types (S4.1 + S4.2) ──────────────────
// Narrow the surface between call sites, the dispatcher, and adapters.
// Adapters ONLY see `AdapterRequest` / `AdapterResponse`; the outer
// `ChatRequest` / `ChatResponse` add metadata (cache flag, cost, ids)
// that is the dispatcher's responsibility.
//
// Token counts are always provider-reported when available (accurate
// for billing); when a provider does not return usage we fall back to
// char-based heuristic and flag `tokens_estimated = true` so analytics
// can discount them.

export type ProviderType = 'openai' | 'anthropic' | 'gemini'

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Input to {@link chatComplete}. */
export interface ChatRequest {
  /**
   * Explicit provider row id. When absent the loader falls back to
   * `llm.default_provider_id` setting, then to the virtual env provider
   * chain (S4.10).
   */
  providerId?: string
  /**
   * Force a specific provider family for the virtual fallback path.
   * Ignored when `providerId` resolves to a real row.
   */
  provider?: ProviderType
  /** Model identifier (provider-specific catalogue). */
  model: string
  messages: Message[]
  /** Max output tokens. Adapters enforce provider-specific ceilings. */
  maxTokens?: number
  /** 0-2 for OpenAI/Gemini, 0-1 for Anthropic. Defaults to 0.2. */
  temperature?: number
  /** AbortSignal timeout in ms. Default 60_000. */
  timeoutMs?: number
  /**
   * Per-request cache TTL override. Set to 0 to disable caching for
   * this call (e.g. non-deterministic task). Defaults to
   * `llm.cache_default_ttl_sec` setting (3600).
   */
  cacheTTLSec?: number
  /** Optional task label for cost analytics (`llm_gateway_logs.task_name`). */
  taskName?: string
  /** User id for audit + cost-per-user analytics. */
  userId?: string
  /** Session id (agent session) for traceability. */
  sessionId?: string
  /**
   * Skip fallback chain on error — dispatcher throws immediately.
   * Used by the retry path inside the fallback loop to prevent
   * infinite recursion.
   */
  _noFallback?: boolean
}

/** Response from {@link chatComplete}. */
export interface ChatResponse {
  content: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  latencyMs: number
  cached: boolean
  /** Provider row id used — may be `env:<provider>` for virtual env fallback. */
  providerId: string
  provider: ProviderType
  model: string
  /** True when token counts came from char-length estimate, not provider usage. */
  tokensEstimated: boolean
}

/** Internal shape adapters consume. */
export interface AdapterRequest {
  apiKey: string
  apiBase: string
  model: string
  messages: Message[]
  maxTokens?: number
  temperature?: number
  timeoutMs: number
}

export interface AdapterResponse {
  content: string
  /**
   * Provider-reported token counts. `null` when the provider response
   * omitted usage — dispatcher will estimate via `estimateTokens()`.
   */
  inputTokens: number | null
  outputTokens: number | null
}

/** Resolved provider — either a DB row or a virtual env fallback. */
export interface ResolvedProvider {
  id: string
  provider: ProviderType
  apiKey: string
  apiBase: string
  /** True when this came from env fallback (no DB row). */
  virtual: boolean
}

// ── Error types ──────────────────────────────────────────
// Every error is a subclass of `LLMGatewayError` so callers can `catch`
// on the base and still branch on `instanceof` for specific handling.

export class LLMGatewayError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LLMGatewayError'
  }
}

export class CostCapExceededError extends LLMGatewayError {
  constructor(public readonly spentUsd: number, public readonly capUsd: number) {
    super(`LLM daily cost cap reached: $${spentUsd.toFixed(4)} / $${capUsd.toFixed(4)}`)
    this.name = 'CostCapExceededError'
  }
}

export class NoProviderConfiguredError extends LLMGatewayError {
  constructor(message = 'No LLM provider configured (no DB row, no env key, or env fallback disabled)') {
    super(message)
    this.name = 'NoProviderConfiguredError'
  }
}

export class ProviderTimeoutError extends LLMGatewayError {
  constructor(public readonly providerId: string, public readonly timeoutMs: number) {
    super(`Provider ${providerId} timed out after ${timeoutMs}ms`)
    this.name = 'ProviderTimeoutError'
  }
}

export class ProviderAuthError extends LLMGatewayError {
  constructor(public readonly providerId: string, detail?: string) {
    super(`Provider ${providerId} auth failed${detail ? `: ${detail}` : ''}`)
    this.name = 'ProviderAuthError'
  }
}

export class ProviderRateLimitError extends LLMGatewayError {
  constructor(public readonly providerId: string, public readonly retryAfterSec?: number) {
    super(`Provider ${providerId} rate-limited${retryAfterSec ? ` (retry after ${retryAfterSec}s)` : ''}`)
    this.name = 'ProviderRateLimitError'
  }
}

export class ProviderError extends LLMGatewayError {
  constructor(
    public readonly providerId: string,
    public readonly statusCode: number,
    detail?: string,
  ) {
    super(`Provider ${providerId} returned ${statusCode}${detail ? `: ${detail}` : ''}`)
    this.name = 'ProviderError'
  }
}
