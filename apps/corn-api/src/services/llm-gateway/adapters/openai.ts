// ─── LLM Gateway — OpenAI adapter (S4.1) ────────────────
// POST {apiBase}/chat/completions with Bearer auth.
// Docs: https://platform.openai.com/docs/api-reference/chat
//
// Assumptions:
//   - Non-streaming only (MVP). S7 chat feature will revisit.
//   - `apiBase` already includes the `/v1` segment (e.g.
//     `https://api.openai.com/v1`). We append `/chat/completions`.

import {
  ProviderAuthError,
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  type AdapterRequest,
  type AdapterResponse,
} from '../types.js'

interface OpenAIChoice {
  message?: { content?: string | null }
  finish_reason?: string
}
interface OpenAIUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}
interface OpenAIResponse {
  choices?: OpenAIChoice[]
  usage?: OpenAIUsage
  error?: { message?: string; type?: string }
}

export async function callOpenAI(
  req: AdapterRequest,
  providerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AdapterResponse> {
  const url = `${req.apiBase.replace(/\/$/, '')}/chat/completions`
  const body = {
    model: req.model,
    messages: req.messages,
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  }

  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(req.timeoutMs),
    })
  } catch (err) {
    // AbortSignal.timeout rejects with a DOMException `TimeoutError`,
    // but different runtimes surface different names; check both.
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

  const data = (await res.json()) as OpenAIResponse
  if (data.error?.message) {
    throw new ProviderError(providerId, res.status, data.error.message)
  }
  const content = data.choices?.[0]?.message?.content ?? ''
  return {
    content: typeof content === 'string' ? content : '',
    inputTokens: typeof data.usage?.prompt_tokens === 'number' ? data.usage.prompt_tokens : null,
    outputTokens:
      typeof data.usage?.completion_tokens === 'number' ? data.usage.completion_tokens : null,
  }
}
