// Per-task heuristic-vs-LLM toggle + per-task LLM knobs. Mirror of
// migration 0015. Heuristic by default — opt-in to LLM per row.
//
// Audit: written explicitly by `services/task-engines.updateTaskEngineConfig()`
// so the per-field diff logic stays in one place. We do NOT register a
// `pre('save')` middleware — the legacy SQL path called updateTaskEngineConfig
// directly, never UPDATE...SET so the schema wouldn't have caught
// out-of-band edits anyway.
import { Schema, model, type InferSchemaType } from 'mongoose'

const taskEngineConfigSchema = new Schema(
  {
    _id: { type: String, required: true }, // task_name PK
    engine: { type: String, enum: ['heuristic', 'llm'], default: 'heuristic', required: true, index: true },
    provider_id: { type: String, default: null },
    model: { type: String, default: null },
    enabled: { type: Boolean, default: true, required: true },
    fallback_to_heuristic: { type: Boolean, default: true, required: true },
    prompt_template: { type: String, default: null },
    timeout_ms: { type: Number, default: 30000 },
    max_input_tokens: { type: Number, default: 8000 },
    max_output_tokens: { type: Number, default: 1024 },
    temperature: { type: Number, default: 0.2 },
    cache_ttl_sec: { type: Number, default: 3600 },
    cost_cap_usd_per_day: { type: Number, default: 0 },
    description: { type: String, default: null },
    updated_by: { type: String, default: null },
  },
  {
    collection: 'task_engine_config',
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
    _id: false,
  },
)

export type TaskEngineConfigDoc = InferSchemaType<typeof taskEngineConfigSchema>
export const TaskEngineConfig = model<TaskEngineConfigDoc>('TaskEngineConfig', taskEngineConfigSchema)
