// Per-(agent, project) checkpoint of the most recent change_event the
// agent has acknowledged. SQLite used a composite PK (agent_id,
// project_id); Mongo gets a synthetic `_id = "<agent>::<project>"` so we
// can keep findById() ergonomics.
import { Schema, model, type InferSchemaType } from 'mongoose'

const agentAckSchema = new Schema(
  {
    _id: { type: String, required: true }, // `${agent_id}::${project_id}`
    agent_id: { type: String, required: true },
    project_id: { type: String, required: true, index: true },
    last_seen_event_id: { type: String, required: true },
  },
  {
    collection: 'agent_ack',
    timestamps: { createdAt: false, updatedAt: 'updated_at' },
    versionKey: false,
    _id: false,
  },
)

export type AgentAckDoc = InferSchemaType<typeof agentAckSchema>
export const AgentAck = model<AgentAckDoc>('AgentAck', agentAckSchema)

/** Build the synthetic _id used for lookups. */
export function agentAckId(agentId: string, projectId: string): string {
  return `${agentId}::${projectId}`
}
