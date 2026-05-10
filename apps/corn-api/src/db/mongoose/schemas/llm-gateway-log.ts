// One row per chatComplete() call (success OR error). cost_usd is 0 for
// cached hits + error rows. 90-day TTL.
import { Schema, Types, model, type InferSchemaType } from 'mongoose'

const llmGatewayLogSchema = new Schema(
  {
    // Legacy AUTOINCREMENT migration rows are Number; new rows use ObjectId
    // via default (Mongoose disables auto-id once _id is declared).
    _id: { type: Schema.Types.Mixed, default: () => new Types.ObjectId() },
    task_name: { type: String, default: null },
    provider_id: { type: String, default: null },
    provider: { type: String, default: null },
    model: { type: String, default: null },
    input_tokens: { type: Number, default: 0 },
    output_tokens: { type: Number, default: 0 },
    // BSON Double — precision matters for $0.000123-class costs.
    cost_usd: { type: Number, default: 0 },
    latency_ms: { type: Number, default: 0 },
    cached: { type: Boolean, default: false },
    error: { type: String, default: null },
    user_id: { type: String, default: null },
    session_id: { type: String, default: null },
  },
  {
    collection: 'llm_gateway_logs',
    timestamps: { createdAt: 'created_at', updatedAt: false },
    versionKey: false,
  },
)

llmGatewayLogSchema.index({ created_at: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 })
llmGatewayLogSchema.index({ created_at: -1 })
llmGatewayLogSchema.index({ task_name: 1, created_at: -1 })
llmGatewayLogSchema.index({ provider_id: 1, created_at: -1 })

export type LlmGatewayLogDoc = InferSchemaType<typeof llmGatewayLogSchema>
export const LlmGatewayLog = model<LlmGatewayLogDoc>('LlmGatewayLog', llmGatewayLogSchema)
