// Per-agent token usage log. 365-day TTL because billing history is
// valuable longer than ops debug logs.
import { Schema, Types, model, type InferSchemaType } from 'mongoose'

const usageLogSchema = new Schema(
  {
    // Legacy AUTOINCREMENT migration rows are Number; new rows use ObjectId
    // via default (Mongoose disables auto-id once _id is declared).
    _id: { type: Schema.Types.Mixed, default: () => new Types.ObjectId() },
    agent_id: { type: String, required: true, index: true },
    model: { type: String, required: true },
    prompt_tokens: { type: Number, default: 0 },
    completion_tokens: { type: Number, default: 0 },
    total_tokens: { type: Number, default: 0 },
    project_id: { type: String, default: null },
    request_type: { type: String, default: 'chat' },
  },
  {
    collection: 'usage_logs',
    timestamps: { createdAt: 'created_at', updatedAt: false },
    versionKey: false,
  },
)

usageLogSchema.index({ created_at: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 })

export type UsageLogDoc = InferSchemaType<typeof usageLogSchema>
export const UsageLog = model<UsageLogDoc>('UsageLog', usageLogSchema)
