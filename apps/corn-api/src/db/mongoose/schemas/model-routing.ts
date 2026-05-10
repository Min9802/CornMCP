// Fallback chain per model purpose ("chat" | "embedding" | "code"). One
// document per purpose; the chain is an ordered list of {accountId, model}
// the LLM gateway tries in sequence.
import { Schema, model, type InferSchemaType } from 'mongoose'

const routingChainItemSchema = new Schema(
  {
    accountId: { type: String, required: true },
    model: { type: String, required: true },
  },
  { _id: false },
)

const modelRoutingSchema = new Schema(
  {
    _id: { type: String, enum: ['chat', 'embedding', 'code'], required: true },
    chain: { type: [routingChainItemSchema], default: [] },
  },
  {
    collection: 'model_routing',
    timestamps: { createdAt: false, updatedAt: 'updated_at' },
    versionKey: false,
    _id: false,
  },
)

export type ModelRoutingDoc = InferSchemaType<typeof modelRoutingSchema>
export const ModelRouting = model<ModelRoutingDoc>('ModelRouting', modelRoutingSchema)
