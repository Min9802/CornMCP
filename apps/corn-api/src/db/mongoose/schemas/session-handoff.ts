// Cross-agent session handoff. The full agent context (branch, files
// changed, decisions, blockers, summary) is packed into the `context`
// Mixed field — schema kept loose because legacy SQLite TEXT JSON has
// no fixed shape and we don't want migration to fail on stray keys.
//
// `expires_at` is nullable: rows without it never expire (TTL skips
// missing values).
import { Schema, model, type InferSchemaType } from 'mongoose'

const sessionHandoffSchema = new Schema(
  {
    _id: { type: String, required: true },
    from_agent: { type: String, required: true },
    to_agent: { type: String, default: null },
    project: { type: String, required: true }, // free-text label, not FK
    task_summary: { type: String, required: true },
    context: { type: Schema.Types.Mixed, required: true, default: () => ({}) },
    priority: { type: Number, default: 5 },
    status: { type: String, default: 'pending', required: true },
    claimed_by: { type: String, default: null },
    project_id: { type: String, default: null, index: true },
    last_activity_at: { type: Date, default: () => new Date() },
    expires_at: { type: Date, default: null },
  },
  {
    collection: 'session_handoffs',
    timestamps: { createdAt: 'created_at', updatedAt: false },
    versionKey: false,
    _id: false,
    strict: false, // tolerate dynamic keys appended by older agents
  },
)

sessionHandoffSchema.index({ status: 1, last_activity_at: 1 })
// Optional TTL on expires_at — null/missing values are skipped by Mongo.
sessionHandoffSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 })

export type SessionHandoffDoc = InferSchemaType<typeof sessionHandoffSchema>
export const SessionHandoff = model<SessionHandoffDoc>('SessionHandoff', sessionHandoffSchema)
