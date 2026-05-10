// Sub-document chunks of a knowledge document. Cascade-deleted with the
// parent document via KnowledgeDocument.pre('deleteOne').
import { Schema, model, type InferSchemaType } from 'mongoose'

const knowledgeChunkSchema = new Schema(
  {
    _id: { type: String, required: true },
    document_id: { type: String, required: true, index: true },
    chunk_index: { type: Number, required: true },
    content: { type: String, required: true },
    char_count: { type: Number, default: 0 },
  },
  {
    collection: 'knowledge_chunks',
    timestamps: { createdAt: 'created_at', updatedAt: false },
    versionKey: false,
    _id: false,
  },
)

knowledgeChunkSchema.index({ document_id: 1, chunk_index: 1 })

export type KnowledgeChunkDoc = InferSchemaType<typeof knowledgeChunkSchema>
export const KnowledgeChunk = model<KnowledgeChunkDoc>('KnowledgeChunk', knowledgeChunkSchema)
