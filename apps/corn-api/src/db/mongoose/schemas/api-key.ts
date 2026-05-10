// API keys issued for MCP / dashboard / programmatic access. The raw key
// is only ever returned once at creation; we store its hash. `permissions`
// is a free-form JSON object — kept Mixed because consumers vary by scope.
//
// NB: there is no FK on `user_id` at the SQL level either (migration 0001
// added the column without a constraint). Cascade still fires from
// `User.deleteOne()` middleware so logically the relation holds.
import { Schema, model, type InferSchemaType } from 'mongoose'

const apiKeySchema = new Schema(
  {
    _id: { type: String, required: true }, // ck_<8 hex>
    name: { type: String, required: true, minlength: 1 },
    key_hash: { type: String, required: true, unique: true },
    scope: { type: String, default: 'all', required: true },
    permissions: { type: Schema.Types.Mixed, default: null },
    project_id: { type: String, default: null, index: true },
    user_id: { type: String, default: null, index: true },
    expires_at: { type: Date, default: null },
    last_used_at: { type: Date, default: null },
  },
  {
    collection: 'api_keys',
    timestamps: { createdAt: 'created_at', updatedAt: false },
    versionKey: false,
    _id: false,
  },
)

export type ApiKeyDoc = InferSchemaType<typeof apiKeySchema>
export const ApiKey = model<ApiKeyDoc>('ApiKey', apiKeySchema)
