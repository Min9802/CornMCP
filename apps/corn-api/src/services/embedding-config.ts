// Embedding-config resolver — single source of truth for `/api/system/embedding-config`.
//
// Resolution order (added in unify-with-provider-accounts refactor):
//   1. `embedding.provider_id` set → resolve from `provider_accounts` row
//      (decrypt api_key, take api_base/dims/models[0]). Per-field fallback
//      to the 4 manual keys when the provider row omits a value.
//   2. `embedding.provider_id` null/missing → read the 4 manual fallback
//      keys directly (legacy behaviour preserved bit-for-bit).
// The 2nd path is exactly the original code; the 1st path only activates
// when an admin explicitly opts in by saving a `provider_id`.

import { getSetting } from './settings.js'
import { decrypt } from './secrets.js'
import { ProviderAccount } from '../db/mongoose/index.js'

export interface EmbeddingConfigPayload {
  apiKey: string | null
  apiBase: string | null
  model: string | null
  dims: number | null
  providerId: string | null
}

export async function resolveEmbeddingConfig(): Promise<EmbeddingConfigPayload> {
  const providerId = await getSetting('embedding.provider_id')

  // Read the 4 manual fallbacks unconditionally — cheap (cached) and lets
  // us defend against partial provider rows (missing dims / models).
  const [manualApiKey, manualApiBase, manualModel, manualDims] = await Promise.all([
    getSetting('embedding.api_key', 'OPENAI_API_KEY'),
    getSetting('embedding.api_base', 'OPENAI_API_BASE'),
    getSetting('embedding.model', 'MEM9_EMBEDDING_MODEL'),
    getSetting('embedding.dims', 'MEM9_EMBEDDING_DIMS'),
  ])

  let apiKey: string | null = manualApiKey ?? null
  let apiBase: string | null = manualApiBase ?? null
  let model: string | null = manualModel ?? null
  let dimsRaw: string | number | null = manualDims

  if (providerId) {
    const provider = await ProviderAccount.findById(providerId, {
      api_base: 1,
      api_key: 1,
      models: 1,
      dims: 1,
      status: 1,
      capabilities: 1,
    }).lean()

    if (!provider) {
      console.warn(`[corn-api] embedding.provider_id="${providerId}" not found — falling back to manual fields`)
    } else if (provider.status !== 'enabled') {
      console.warn(`[corn-api] embedding.provider_id="${providerId}" status=${provider.status} — falling back to manual fields`)
    } else {
      // Decrypt api_key — encrypt() is idempotent + null-safe so plaintext
      // legacy rows pass through. Wrap in try so a tampered envelope can't
      // 500 the whole endpoint.
      let decryptedKey: string | null = null
      try {
        const dec = decrypt(provider.api_key)
        decryptedKey = typeof dec === 'string' && dec !== '' ? dec : null
      } catch {
        console.warn(`[corn-api] embedding provider api_key decrypt failed — using manual fallback`)
      }

      // Per-field merge: provider values win, manual fallbacks fill gaps so
      // a provider with no `dims` (e.g. user only configured it for chat
      // and toggled embedding capability later) still resolves.
      apiKey = decryptedKey ?? apiKey
      apiBase = provider.api_base || apiBase
      const providerModel = Array.isArray(provider.models) ? provider.models[0] : undefined
      model = providerModel || model
      dimsRaw = typeof provider.dims === 'number' && provider.dims > 0 ? provider.dims : dimsRaw
    }
  }

  const parsedDims = typeof dimsRaw === 'number' ? dimsRaw : dimsRaw === null ? null : Number(dimsRaw)
  return {
    apiKey: apiKey ?? null,
    apiBase: apiBase ?? null,
    model: model ?? null,
    dims: Number.isFinite(parsedDims) && parsedDims! > 0 ? parsedDims : null,
    providerId: providerId ?? null,
  }
}
