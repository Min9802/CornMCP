// Code knowledge graph — directed edges between symbols (call, import,
// reference, ...). AUTOINCREMENT id from SQLite preserved as Number;
// new edges post-migration use ObjectId.
import { Schema, Types, model, type InferSchemaType } from 'mongoose'

const codeEdgeSchema = new Schema(
  {
    // Legacy Number from AUTOINCREMENT migration | new ObjectId via default.
    _id: { type: Schema.Types.Mixed, default: () => new Types.ObjectId() },
    project_id: { type: String, required: true, index: true },
    source_symbol_id: { type: String, required: true, index: true },
    target_symbol_id: { type: String, required: true, index: true },
    kind: { type: String, required: true, index: true },
    file_path: { type: String, default: null },
    line_number: { type: Number, default: null },
  },
  {
    collection: 'code_edges',
    timestamps: { createdAt: 'created_at', updatedAt: false },
    versionKey: false,
  },
)

export type CodeEdgeDoc = InferSchemaType<typeof codeEdgeSchema>
export const CodeEdge = model<CodeEdgeDoc>('CodeEdge', codeEdgeSchema)
