// Knowledge document metadata. The chunked content + vectors live in
// Qdrant; this collection is the dashboard preview / list / delete layer.
// Cascade: deleting a document removes its chunks.
import mongoose, { Schema, model, type InferSchemaType } from 'mongoose'

const knowledgeDocumentSchema = new Schema(
  {
    _id: { type: String, required: true },
    title: { type: String, required: true, minlength: 1 },
    source: { type: String, default: 'manual' },
    source_agent_id: { type: String, default: null },
    project_id: { type: String, default: null, index: true },
    tags: { type: [String], default: [] },
    status: { type: String, default: 'active' },
    hit_count: { type: Number, default: 0 },
    chunk_count: { type: Number, default: 0 },
    content_preview: { type: String, default: null },
    // Added by SQLite migration 0001 — owner; null = legacy global doc.
    user_id: { type: String, default: null, index: true },
  },
  {
    collection: 'knowledge_documents',
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
    _id: false,
  },
)

knowledgeDocumentSchema.index({ tags: 1 })

knowledgeDocumentSchema.pre('deleteOne', { document: true, query: false }, async function () {
  await mongoose.model('KnowledgeChunk').deleteMany({ document_id: this._id })
})

export type KnowledgeDocumentDoc = InferSchemaType<typeof knowledgeDocumentSchema>
export const KnowledgeDocument = model<KnowledgeDocumentDoc>('KnowledgeDocument', knowledgeDocumentSchema)
