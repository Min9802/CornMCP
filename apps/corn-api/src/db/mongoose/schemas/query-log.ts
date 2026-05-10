// MCP tool invocation log. One row per tool call (success or error).
// `params` is dynamic JSON — we sanitize key names at ingest time
// (replace `.` and `$`, see plan section 11.2).
import { Schema, Types, model, type InferSchemaType } from 'mongoose'

const queryLogSchema = new Schema(
  {
    // Legacy AUTOINCREMENT migration rows are Number; new rows use ObjectId
    // via default (Mongoose disables auto-id once _id is declared).
    _id: { type: Schema.Types.Mixed, default: () => new Types.ObjectId() },
    agent_id: { type: String, required: true },
    tool: { type: String, required: true },
    params: { type: Schema.Types.Mixed, default: null },
    latency_ms: { type: Number, default: null },
    status: { type: String, default: 'ok' },
    error: { type: String, default: null },
    project_id: { type: String, default: null },
    input_size: { type: Number, default: 0 },
    output_size: { type: Number, default: 0 },
    compute_tokens: { type: Number, default: 0 },
    tokens_saved: { type: Number, default: 0 },
    compute_model: { type: String, default: null },
  },
  {
    collection: 'query_logs',
    timestamps: { createdAt: 'created_at', updatedAt: false },
    versionKey: false,
    strict: false, // tolerate extra free-form fields (legacy debug breadcrumbs)
  },
)

// 90-day TTL on created_at — keeps the collection bounded.
queryLogSchema.index({ created_at: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 })
queryLogSchema.index({ agent_id: 1, created_at: -1 })

export type QueryLogDoc = InferSchemaType<typeof queryLogSchema>
export const QueryLog = model<QueryLogDoc>('QueryLog', queryLogSchema)
