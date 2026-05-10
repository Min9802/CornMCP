// Append-only audit trail for `system_settings`. SQLite used INTEGER
// AUTOINCREMENT — we preserve those IDs as `_id: Number` during migration
// so deep links from the admin UI keep working. New rows post-migration
// use ObjectId via auto-generation.
import { Schema, Types, model, type InferSchemaType } from 'mongoose'

const systemSettingAuditSchema = new Schema(
  {
    // Mixed: legacy migrated rows are Number, new rows are ObjectId.
    // Default required because Mongoose only auto-generates _id when the
    // field is left undeclared; declaring it switches off the auto-id.
    _id: { type: Schema.Types.Mixed, default: () => new Types.ObjectId() },
    key: { type: String, required: true },
    old_value: { type: String, default: null },
    new_value: { type: String, default: null },
    // 'reveal' is not produced by setSetting() — it's logged separately by
    // settings.auditReveal() when an admin views a plaintext secret. Kept
    // alongside set/update/reset so the audit timeline renders the full
    // history in one query.
    action: { type: String, enum: ['set', 'update', 'reset', 'reveal'], default: 'set', required: true },
    changed_by: { type: String, default: null },
    changed_at: { type: Date, default: () => new Date() },
  },
  {
    collection: 'system_settings_audit',
    timestamps: false,
    versionKey: false,
  },
)

systemSettingAuditSchema.index({ key: 1, changed_at: -1 })

export type SystemSettingAuditDoc = InferSchemaType<typeof systemSettingAuditSchema>
export const SystemSettingAudit = model<SystemSettingAuditDoc>('SystemSettingAudit', systemSettingAuditSchema)
