// Code knowledge graph — symbol nodes (functions, classes, methods, ...).
// `parent_symbol_id` is a self-reference for nested symbols; query
// hierarchies via `$graphLookup` (see plan section 11.13).
//
// Cascade middleware: deleting a symbol drops every edge it touches.
import mongoose, { Schema, model, type InferSchemaType } from 'mongoose'

const codeSymbolSchema = new Schema(
  {
    _id: { type: String, required: true },
    project_id: { type: String, required: true, index: true },
    name: { type: String, required: true, index: true },
    kind: { type: String, required: true, index: true },
    file_path: { type: String, required: true, index: true },
    start_line: { type: Number, required: true },
    end_line: { type: Number, required: true },
    exported: { type: Boolean, default: false },
    signature: { type: String, default: null },
    doc_comment: { type: String, default: null },
    parent_symbol_id: { type: String, ref: 'CodeSymbol', default: null, index: true },
  },
  {
    collection: 'code_symbols',
    timestamps: { createdAt: 'created_at', updatedAt: false },
    versionKey: false,
    _id: false,
  },
)

codeSymbolSchema.pre('deleteOne', { document: true, query: false }, async function () {
  const id = this._id
  await mongoose.model('CodeEdge').deleteMany({
    $or: [{ source_symbol_id: id }, { target_symbol_id: id }],
  })
})

export type CodeSymbolDoc = InferSchemaType<typeof codeSymbolSchema>
export const CodeSymbol = model<CodeSymbolDoc>('CodeSymbol', codeSymbolSchema)
