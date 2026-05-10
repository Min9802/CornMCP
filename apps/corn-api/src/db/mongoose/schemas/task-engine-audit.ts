// Append-only audit for task_engine_config. One row per CHANGED FIELD
// (see task-engine-config schema's pre('save')). Mixed _id type because
// legacy AUTOINCREMENT IDs from SQLite are preserved as Number while new
// post-migration rows use ObjectId.
import { Schema, Types, model, type InferSchemaType } from 'mongoose'

const taskEngineAuditSchema = new Schema(
  {
    // Mixed: legacy AUTOINCREMENT rows stay Number, new rows get ObjectId
    // via the default below (Mongoose skips auto-id once _id is declared).
    _id: { type: Schema.Types.Mixed, default: () => new Types.ObjectId() },
    task_name: { type: String, required: true },
    field: { type: String, required: true },
    old_value: { type: String, default: null },
    new_value: { type: String, default: null },
    action: { type: String, enum: ['update', 'test', 'reset'], default: 'update', required: true },
    changed_by: { type: String, default: null },
    changed_at: { type: Date, default: () => new Date() },
  },
  {
    collection: 'task_engine_audit',
    timestamps: false,
    versionKey: false,
  },
)

taskEngineAuditSchema.index({ task_name: 1, changed_at: -1 })
taskEngineAuditSchema.index({ changed_at: -1 })

export type TaskEngineAuditDoc = InferSchemaType<typeof taskEngineAuditSchema>
export const TaskEngineAudit = model<TaskEngineAuditDoc>('TaskEngineAudit', taskEngineAuditSchema)
