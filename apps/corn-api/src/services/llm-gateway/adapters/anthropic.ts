// ─── LLM Gateway — Anthropic adapter (S4.1) ─────────────
// POST {apiBase}/messages with `x-api-key` + `anthropic-version` headers.
// Docs: https://docs.anthropic.com/en/api/messages
//
// Key differences vs OpenAI:
//   - Auth header is `x-api-key` (NOT Bearer).
//   - `system` role isn't allowed in `messages[]`; promote to top-level
//     `system` field.
//   - Response shape: `content: [{type: 'text', text: '...'}]` array.
//   - Usage field names: `input_tokens` / `output_tokens`.
//   - `max_tokens` is REQUIRED (unlike OpenAI). Default 1024 if absent.

import {
  ProviderAuthError,
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  type AdapterRequest,
  type AdapterResponse,
  type Message,
} from '../types.js'

const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicContentBlock {
  type?: string
  text?: string
}
interface AnthropicResponse {
  content?: AnthropicContentBlock[]
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { type?: string; message?: string }
  type?: string
}

function splitSystem(messages: Message[]): { system: string; rest: Message[] } {
  const systemParts: string[] = []
  const rest: Message[] = []
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content)
    else rest.push(m)
  }
  return { system: systemParts.join('\n\n'), rest }
}

export async function callAnthropic(
  req: AdapterRequest,
  providerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AdapterResponse> {
  const url = `${req.apiBase.replace(/\/$/, '')}/messages`
  const { system, rest } = splitSystem(req.messages)
  const body: Record<string, unknown> = {
    model: req.model,
    messages: rest,
    max_tokens: req.maxTokens ?? 1024,
  }
  if (system) body['system'] = system
  if (req.temperature !== undefined) body['temperature'] = req.temperature

  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': req.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(req.timeoutMs),
    })
  } catch (err) {
    const name = (err as Error).name
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ProviderTimeoutError(providerId, req.timeoutMs)
    }
    throw err
  }

  if (res.status === 401 || res.status === 403) {
    const text = await res.text().catch(() => '')
    throw new ProviderAuthError(providerId, text || `HTTP ${res.status}`)
  }
  if (res.status === 429) {
    const retryAfterHeader = res.headers.get('retry-after')
    const retry = retryAfterHeader ? Number(retryAfterHeader) : undefined
    throw new ProviderRateLimitError(providerId, Number.isFinite(retry) ? retry : undefined)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ProviderError(providerId, res.status, text.slice(0, 500))
  }

  const data = (await res.json()) as AnthropicResponse
  if (data.type === 'error' || data.error?.message) {
    throw new ProviderError(providerId, res.status, data.error?.message ?? 'anthropic error')
  }
  // Concatenate all `text` blocks; ignore non-text (tool_use etc.) for MVP.
  const content = (data.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
  return {
    content,
    inputTokens: typeof data.usage?.input_tokens === 'number' ? data.usage.input_tokens : null,
    outputTokens:
      typeof data.usage?.output_tokens === 'number' ? data.usage.output_tokens : null,
  }
}
