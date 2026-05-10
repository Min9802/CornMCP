// SINGLETON — at most one document with `_id: 'singleton'`. The original
// SQLite table used `id INTEGER DEFAULT 1` for the same purpose. Init script
// upserts the row on every boot so a fresh DB always has the gate flag.
import { Schema, model, type InferSchemaType } from 'mongoose'

const setupStatusSchema = new Schema(
  {
    _id: { type: String, default: 'singleton' },
    completed: { type: Boolean, required: true, default: false },
    completed_at: { type: Date, default: null },
  },
  {
    collection: 'setup_status',
    timestamps: false,
    versionKey: false,
    _id: false,
  },
)

export type SetupStatusDoc = InferSchemaType<typeof setupStatusSchema>
export const SetupStatus = model<SetupStatusDoc>('SetupStatus', setupStatusSchema)
