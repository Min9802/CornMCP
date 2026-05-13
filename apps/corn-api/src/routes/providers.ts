import { Hono } from 'hono'
import { generateId } from '@corn/shared-utils'
import { ProviderAccount } from '../db/mongoose/index.js'
import { jwtAuthMiddleware, getAuthCtx } from '../middleware/auth.js'
import { encrypt, isEncrypted, maskSecret } from '../services/secrets.js'

// ── Defense-in-depth: hide raw `api_key` from list/get responses. Callers
// that need to *use* the key (provider proxy, LLM gateway) decrypt server-side
// via secrets.decrypt(). UI surfaces show only `api_key_masked` / `api_key_last4`.
// A future `/reveal` endpoint (S3.3) handles admin re-display with rate-limit + audit.
function sanitizeProvider(row: Record<string, unknown>): Record<string, unknown> {
  const apiKey = (row['api_key'] as string | null | undefined) ?? null
  const masked = apiKey ? maskSecret(apiKey) : ''
  const last4 = masked.startsWith('\u2022\u2022\u2022\u2022') ? masked.slice(4) : ''
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { api_key: _drop, _id, ...safe } = row
  return {
    id: _id ?? row['id'],
    ...safe,
    api_key_masked: masked,
    api_key_last4: last4,
    api_key_set: Boolean(apiKey),
  }
}

export const providersRouter = new Hono()

// ── Copilot/GitHub provider presets ──────────────────────
const PROVIDER_PRESETS: Record<string, { apiBase: string; authType: string; models: string[] }> = {
  copilot: {
    apiBase: 'https://api.githubcopilot.com/v1',
    authType: 'bearer',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'claude-3.7-sonnet', 'claude-sonnet-4-5'],
  },
  'github-models': {
    apiBase: 'https://models.inference.ai.azure.com',
    authType: 'bearer',
    models: ['gpt-4o', 'gpt-4.5-turbo', 'Meta-Llama-3.1-70B-Instruct', 'Mistral-large-2411', 'DeepSeek-V3'],
  },
}

providersRouter.use('*', jwtAuthMiddleware)

// ─── List providers ─────────────────
providersRouter.get('/', async (c) => {
  const { user } = getAuthCtx(c)

  const filter = user.role === 'admin' ? {} : { user_id: user.id }
  const rows = await ProviderAccount.find(filter).sort({ created_at: -1 }).lean()

  return c.json({ providers: rows.map((r) => sanitizeProvider(r as Record<string, unknown>)) })
})

// ─── List embedding-capable providers ──────────────────
// Used by System Settings → Embedding picker so the admin can swap the
// active embedding provider without re-entering api_base/key/dims.
// Returns ALL providers (regardless of user_id) because the system
// setting `embedding.provider_id` is system-wide — the admin must be
// able to reference any enabled provider in the catalogue.
providersRouter.get('/embedding-candidates', async (c) => {
  const { user } = getAuthCtx(c)
  if (user.role !== 'admin') return c.json({ error: 'Admin role required' }, 403)

  const rows = await ProviderAccount.find(
    { capabilities: 'embedding', status: 'enabled' },
    {
      _id: 1, name: 1, type: 1, api_base: 1, api_key: 1, models: 1, dims: 1,
      status: 1, capabilities: 1, user_id: 1, created_at: 1,
    },
  ).sort({ created_at: -1 }).lean()

  return c.json({ providers: rows.map((r) => sanitizeProvider(r as Record<string, unknown>)) })
})

// ─── Create provider ──────────────────────
providersRouter.post('/', async (c) => {
  const body = await c.req.json()
  const { user } = getAuthCtx(c)
  const id = generateId('prov')

  const type = body.type || 'openai'
  const preset = PROVIDER_PRESETS[type]
  const apiBase = body.apiBase || preset?.apiBase || ''
  const authType = body.authType || preset?.authType || 'api_key'
  const models = body.models?.length ? body.models : (preset?.models || [])

  if (!apiBase) return c.json({ error: 'api_base is required' }, 400)

  // Normalise capabilities to an array of known tokens; default ['chat']
  // matches the schema default. Embedding capability requires `dims` so
  // the resolver in /embedding-config can pick a valid Qdrant size.
  const capabilities: string[] = Array.isArray(body.capabilities) && body.capabilities.length > 0
    ? body.capabilities.map((s: unknown) => String(s)).filter(Boolean)
    : ['chat']
  const dimsRaw = body.dims
  const dims: number | null =
    typeof dimsRaw === 'number' && dimsRaw > 0
      ? Math.floor(dimsRaw)
      : typeof dimsRaw === 'string' && /^\d+$/.test(dimsRaw) && Number(dimsRaw) > 0
        ? Number(dimsRaw)
        : null
  if (capabilities.includes('embedding') && dims === null) {
    return c.json({ error: 'dims (positive integer) is required when capabilities include "embedding"' }, 400)
  }

  // S1.5 — wrap api_key in AES-GCM envelope before write. encrypt() is
  // idempotent (already-encrypted values pass through) and null-safe.
  // The encrypted string is preserved bit-for-bit (HIGH RISK section 6.1).
  const rawKey: string | null = body.apiKey || null
  const storedKey = rawKey === null ? null : (encrypt(rawKey) as string)
  const encryptedFlag = Boolean(storedKey && isEncrypted(storedKey))

  await ProviderAccount.create({
    _id: id,
    name: body.name || type,
    type,
    auth_type: authType,
    api_base: apiBase,
    api_key: storedKey,
    api_key_encrypted: encryptedFlag,
    status: body.status || 'enabled',
    capabilities,
    models,
    dims,
    user_id: user.id,
  } as Parameters<typeof ProviderAccount.create>[0])

  return c.json({ ok: true, id })
})

// ─── Update provider ──────────────────────────
providersRouter.patch('/:id', async (c) => {
  const { id } = c.req.param()
  const { user } = getAuthCtx(c)
  const body = await c.req.json()

  if (user.role !== 'admin') {
    const p = await ProviderAccount.findById(id, { user_id: 1 }).lean()
    if (!p) return c.json({ error: 'Provider not found' }, 404)
    if (p.user_id !== user.id) return c.json({ error: 'Access denied' }, 403)
  }

  const update: Record<string, unknown> = {}
  if (body.name) update['name'] = body.name
  if (body.status) update['status'] = body.status
  if (body.apiBase) update['api_base'] = body.apiBase
  if (body.apiKey !== undefined) {
    // S1.5 — encrypt rotated key + flip tracking flag in the same write
    // so a partial sweep can resume without re-encrypting this row.
    const rawKey: string | null = body.apiKey || null
    const storedKey = rawKey === null ? null : (encrypt(rawKey) as string)
    const encryptedFlag = Boolean(storedKey && isEncrypted(storedKey))
    update['api_key'] = storedKey
    update['api_key_encrypted'] = encryptedFlag
  }
  if (body.models) update['models'] = body.models
  if (body.capabilities) update['capabilities'] = body.capabilities
  if (body.dims !== undefined) {
    const dimsRaw = body.dims
    if (dimsRaw === null || dimsRaw === '') {
      update['dims'] = null
    } else if (typeof dimsRaw === 'number' && dimsRaw > 0) {
      update['dims'] = Math.floor(dimsRaw)
    } else if (typeof dimsRaw === 'string' && /^\d+$/.test(dimsRaw) && Number(dimsRaw) > 0) {
      update['dims'] = Number(dimsRaw)
    } else {
      return c.json({ error: 'dims must be a positive integer or null' }, 400)
    }
  }

  // Cross-field validation: if final capability set contains 'embedding',
  // dims must be present (either in this PATCH or already on the row).
  if (Array.isArray(update['capabilities']) && (update['capabilities'] as string[]).includes('embedding')) {
    const finalDims = update['dims'] !== undefined
      ? update['dims']
      : (await ProviderAccount.findById(id, { dims: 1 }).lean())?.dims ?? null
    if (typeof finalDims !== 'number' || finalDims <= 0) {
      return c.json({ error: 'dims is required when capabilities include "embedding"' }, 400)
    }
  }

  if (Object.keys(update).length === 0) {
    return c.json({ ok: true })
  }

  // updated_at is auto-managed by `timestamps: true` on the schema.
  await ProviderAccount.updateOne({ _id: id }, { $set: update })
  return c.json({ ok: true })
})

// ─── Delete provider ──────────────────────────
providersRouter.delete('/:id', async (c) => {
  const { id } = c.req.param()
  const { user } = getAuthCtx(c)

  if (user.role !== 'admin') {
    const p = await ProviderAccount.findById(id, { user_id: 1 }).lean()
    if (!p) return c.json({ error: 'Provider not found' }, 404)
    if (p.user_id !== user.id) return c.json({ error: 'Access denied' }, 403)
  }

  await ProviderAccount.deleteOne({ _id: id })
  return c.json({ ok: true })
})

// ─── Get presets info (for frontend) ─────────────────────
providersRouter.get('/presets', (c) => {
  return c.json({ presets: PROVIDER_PRESETS })
})
