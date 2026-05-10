// Quality gate report. `details` is dynamic JSON (per-gate output) so
// we keep it Mixed.
import { Schema, model, type InferSchemaType } from 'mongoose'

const qualityReportSchema = new Schema(
  {
    _id: { type: String, required: true },
    project_id: { type: String, default: null },
    agent_id: { type: String, required: true },
    session_id: { type: String, default: null },
    gate_name: { type: String, required: true },
    score_build: { type: Number, default: 0 },
    score_regression: { type: Number, default: 0 },
    score_standards: { type: Number, default: 0 },
    score_traceability: { type: Number, default: 0 },
    score_total: { type: Number, default: 0 },
    grade: { type: String, enum: ['A', 'B', 'C', 'D', 'F'], default: 'F', required: true },
    passed: { type: Boolean, default: false, required: true },
    details: { type: Schema.Types.Mixed, default: null },
    // Added by SQLite migration 0001 — owner of the report (null for
    // legacy rows produced before tenancy).
    user_id: { type: String, default: null, index: true },
  },
  {
    collection: 'quality_reports',
    timestamps: { createdAt: 'created_at', updatedAt: false },
    versionKey: false,
    _id: false,
  },
)

qualityReportSchema.index({ project_id: 1, created_at: -1 })
qualityReportSchema.index({ agent_id: 1, created_at: -1 })

export type QualityReportDoc = InferSchemaType<typeof qualityReportSchema>
export const QualityReport = model<QualityReportDoc>('QualityReport', qualityReportSchema)
