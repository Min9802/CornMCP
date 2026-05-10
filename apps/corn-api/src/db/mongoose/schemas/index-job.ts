// Background indexing job — clones a repo, runs the AST engine, ingests
// vectors into Qdrant via mem9. Wide schema because the dashboard
// surfaces every per-stage progress field.
import { Schema, model, type InferSchemaType } from 'mongoose'

const indexJobSchema = new Schema(
  {
    _id: { type: String, required: true },
    project_id: { type: String, required: true },
    branch: { type: String, default: 'main' },
    status: {
      type: String,
      enum: ['pending', 'cloning', 'analyzing', 'ingesting', 'done', 'error'],
      default: 'pending',
      required: true,
    },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    total_files: { type: Number, default: 0 },
    symbols_found: { type: Number, default: 0 },
    log: { type: String, default: null },
    error: { type: String, default: null },
    commit_hash: { type: String, default: null },
    commit_message: { type: String, default: null },
    triggered_by: { type: String, default: 'manual' },
    mem9_status: { type: String, default: null },
    mem9_chunks: { type: Number, default: 0 },
    mem9_progress: { type: Number, default: 0 },
    mem9_total_chunks: { type: Number, default: 0 },
    docs_knowledge_status: { type: String, default: null },
    docs_knowledge_count: { type: Number, default: 0 },
    started_at: { type: Date, default: null },
    completed_at: { type: Date, default: null },
  },
  {
    collection: 'index_jobs',
    timestamps: { createdAt: 'created_at', updatedAt: false },
    versionKey: false,
    _id: false,
  },
)

indexJobSchema.index({ project_id: 1, created_at: -1 })

export type IndexJobDoc = InferSchemaType<typeof indexJobSchema>
export const IndexJob = model<IndexJobDoc>('IndexJob', indexJobSchema)
