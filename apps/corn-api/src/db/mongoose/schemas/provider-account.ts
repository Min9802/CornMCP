// Configured LLM provider accounts (OpenAI, Anthropic, Voyage, ...).
// `api_key` is base64-encoded ciphertext when `api_key_encrypted=true` —
// migration must NOT decode/re-encode it; bit-for-bit preservation is
// required for the master key to decrypt later (see plan section 6.1).
import { Schema, model, type InferSchemaType } from 'mongoose'

const providerAccountSchema = new Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true, minlength: 1 },
    type: { type: String, required: true, index: true },
    auth_type: { type: String, default: 'api_key' },
    api_base: { type: String, required: true },
    api_key: { type: String, default: null },
    api_key_encrypted: { type: Boolean, default: false, required: true },
    status: { type: String, default: 'enabled', index: true },
    capabilities: { type: [String], default: ['chat'] },
    models: { type: [String], default: [] },
    // Embedding vector dimensionality — required when `capabilities` includes
    // 'embedding' so /api/system/embedding-config can resolve the dim that
    // matches the Qdrant collection. Null/omitted for chat-only providers.
    dims: { type: Number, default: null },
    // Added by SQLite migration 0001 — owner of the provider account
    // (null = legacy global account from before tenancy was introduced).
    user_id: { type: String, default: null, index: true },
  },
  {
    collection: 'provider_accounts',
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
    _id: false,
  },
)

export type ProviderAccountDoc = InferSchemaType<typeof providerAccountSchema>
export const ProviderAccount = model<ProviderAccountDoc>('ProviderAccount', providerAccountSchema)
