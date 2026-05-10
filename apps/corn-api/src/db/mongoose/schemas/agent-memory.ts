// Agent memory metadata. Real vector content lives in Qdrant via mem9;
// this collection drives the dashboard list/audit/delete UI.
import { Schema, model, type InferSchemaType } from 'mongoose'

const agentMemorySchema = new Schema(
  {
    _id: { type: String, required: true }, // mem-<hex>
    content: { type: String, required: true },
    content_preview: { type: String, default: null },
    agent_id: { type: String, default: null },
    project_id: { type: String, default: null, index: true },
    branch: { type: String, default: null },
    tags: { type: [String], default: [] },
    user_id: { type: String, default: null, index: true },
    hit_count: { type: Number, default: 0 },
  },
  {
    collection: 'agent_memories',
    timestamps: { createdAt: 'created_at', updatedAt: false },
    versionKey: false,
    _id: false,
  },
)

agentMemorySchema.index({ agent_id: 1, created_at: -1 })
agentMemorySchema.index({ project_id: 1, branch: 1 })
agentMemorySchema.index({ tags: 1 })

export type AgentMemoryDoc = InferSchemaType<typeof agentMemorySchema>
export const AgentMemory = model<AgentMemoryDoc>('AgentMemory', agentMemorySchema)
