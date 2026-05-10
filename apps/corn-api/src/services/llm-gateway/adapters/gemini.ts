// ─── LLM Gateway — Gemini adapter (S4.1) ────────────────
// POST {apiBase}/models/{model}:generateContent?key={apiKey}
// Docs: https://ai.google.dev/api/generate-content
//
// Key differences vs OpenAI/Anthropic:
//   - Auth is a query param `?key=<apiKey>` (there's also an OAuth path
//     but the API-key flow is what Voyage/Gemini Flash use in practice).
//   - `messages` becomes `contents`: `[{role, parts: [{text}]}]`.
//   - Roles map: `system` → `systemInstruction` top-level, `assistant` →
//     `model`, `user` → `user`. (Provider rejects `system` inside contents.)
//   - Usage under `usageMetadata.{promptTokenCount,candidatesTokenCount}`.

import {
  ProviderAuthError,
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  type AdapterRequest,
  type AdapterResponse,
  type Message,
} from '../types.js'

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> }
  finishReason?: string
}
interface GeminiResponse {
  candidates?: GeminiCandidate[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
  error?: { code?: number; message?: string; status?: string }
}

function toGeminiContents(
  messages: Message[],
): { contents: unknown[]; systemInstruction?: { parts: Array<{ text: string }> } } {
  const systemParts: string[] = []
  const contents: unknown[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content)
      continue
    }
    const role = m.role === 'assistant' ? 'model' : 'user'
    contents.push({ role, parts: [{ text: m.content }] })
  }
  const systemInstruction = systemParts.length > 0
    ? { parts: [{ text: systemParts.join('\n\n') }] }
    : undefined
  return systemInstruction ? { contents, systemInstruction } : { contents }
}

export async function callGemini(
  req: AdapterRequest,
  providerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AdapterResponse> {
  const base = req.apiBase.replace(/\/$/, '')
  const url = `${base}/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(req.apiKey)}`
  const { contents, systemInstruction } = toGeminiContents(req.messages)

  const generationConfig: Record<string, unknown> = {}
  if (req.maxTokens !== undefined) generationConfig['maxOutputTokens'] = req.maxTokens
  if (req.temperature !== undefined) generationConfig['temperature'] = req.temperature

  const body: Record<string, unknown> = { contents }
  if (systemInstruction) body['systemInstruction'] = systemInstruction
  if (Object.keys(generationConfig).length > 0) body['generationConfig'] = generationConfig

  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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

  const data = (await res.json()) as GeminiResponse
  if (data.error?.message) {
    throw new ProviderError(providerId, data.error.code ?? res.status, data.error.message)
  }
  const parts = data.candidates?.[0]?.content?.parts ?? []
  const content = parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
  return {
    content,
    inputTokens:
      typeof data.usageMetadata?.promptTokenCount === 'number'
        ? data.usageMetadata.promptTokenCount
        : null,
    outputTokens:
      typeof data.usageMetadata?.candidatesTokenCount === 'number'
        ? data.usageMetadata.candidatesTokenCount
        : null,
  }
}
