// Project — owned by an organization. Cascade middleware fans out to
// every collection that references project_id. Wrapped in a transaction
// when the topology supports it (replica set / sharded), otherwise run
// non-atomically so dev environments on standalone Mongo still work.
//
// IMPORTANT: like User, only the document-level `pre('deleteOne')` runs
// the cascade. Callers that bulk-delete with `Project.deleteMany(filter)`
// will skip it; for those paths register a query middleware too.
import mongoose, { Schema, model, type ClientSession, type InferSchemaType } from 'mongoose'
import { supportsTransactions } from '../connection.js'

const projectSchema = new Schema(
  {
    _id: { type: String, required: true },
    org_id: { type: String, required: true, index: true },
    name: { type: String, required: true, minlength: 1 },
    slug: { type: String, required: true },
    description: { type: String, default: null },
    git_repo_url: { type: String, default: null },
    git_provider: { type: String, default: null },
    indexed_at: { type: Date, default: null },
    indexed_symbols: { type: Number, default: 0 },
  },
  {
    collection: 'projects',
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
    _id: false,
  },
)

projectSchema.index({ org_id: 1, slug: 1 }, { unique: true })

/** Run the actual cascade deletes. Optional session = atomic mode. */
async function fanOutProjectDeletes(projectId: string, session: ClientSession | null): Promise<void> {
  const opts = session ? { session } : {}
  // First fan-out: collections that don't have their own cascade.
  await Promise.all([
    mongoose.model('IndexJob').deleteMany({ project_id: projectId }, opts),
    mongoose.model('ChangeEvent').deleteMany({ project_id: projectId }, opts),
    mongoose.model('CodeEdge').deleteMany({ project_id: projectId }, opts),
    mongoose.model('CodeSymbol').deleteMany({ project_id: projectId }, opts),
    mongoose.model('AgentMemory').deleteMany({ project_id: projectId }, opts),
    mongoose.model('QualityReport').deleteMany({ project_id: projectId }, opts),
    mongoose.model('SessionHandoff').deleteMany({ project_id: projectId }, opts),
    mongoose.model('AgentAck').deleteMany({ project_id: projectId }, opts),
    // KnowledgeChunk has its own cascade off KnowledgeDocument; do
    // not delete chunks here to avoid double-fire.
  ])
  // KnowledgeDocument cascade-deletes its chunks via its own middleware,
  // so we iterate documents and let each one tear down its chunks.
  const KnowledgeDoc = mongoose.model('KnowledgeDocument')
  const docs = await KnowledgeDoc.find({ project_id: projectId }, '_id', opts).lean()
  for (const d of docs) {
    const q = KnowledgeDoc.findById(d._id)
    const inst = session ? await q.session(session) : await q
    if (!inst) continue
    if (session) {
      await inst.deleteOne({ session })
    } else {
      await inst.deleteOne()
    }
  }
}

projectSchema.pre('deleteOne', { document: true, query: false }, async function () {
  const projectId = this._id as string
  if (supportsTransactions()) {
    const session = await mongoose.startSession()
    try {
      await session.withTransaction(() => fanOutProjectDeletes(projectId, session))
    } finally {
      await session.endSession()
    }
    return
  }
  // Standalone Mongo: best-effort non-atomic cascade. A partial failure
  // here can leave orphan rows tied to the deleted projectId — acceptable
  // for dev; production should run a replica set so we keep atomicity.
  await fanOutProjectDeletes(projectId, null)
})

export type ProjectDoc = InferSchemaType<typeof projectSchema>
export const Project = model<ProjectDoc>('Project', projectSchema)
