// Cross-agent change feed (commit-level). Used to drive
// "while you were away" notifications. TTL=30 days.
import { Schema, model, type InferSchemaType } from 'mongoose'

const changeEventSchema = new Schema(
  {
    _id: { type: String, required: true },
    project_id: { type: String, required: true },
    branch: { type: String, required: true },
    agent_id: { type: String, default: null },
    commit_sha: { type: String, default: null },
    commit_message: { type: String, default: null },
    files_changed: { type: [String], default: null }, // null = unknown, [] = no changes
  },
  {
    collection: 'change_events',
    timestamps: { createdAt: 'created_at', updatedAt: false },
    versionKey: false,
    _id: false,
  },
)

// 30-day TTL — older events get cleaned up automatically.
changeEventSchema.index({ created_at: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 })
changeEventSchema.index({ project_id: 1, created_at: -1 })

export type ChangeEventDoc = InferSchemaType<typeof changeEventSchema>
export const ChangeEvent = model<ChangeEventDoc>('ChangeEvent', changeEventSchema)
