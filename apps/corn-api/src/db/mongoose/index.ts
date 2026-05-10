// Barrel re-export so callers can do:
//   import { User, Project, ... } from '../db/mongoose/index.js'
//
// Listed in dependency tier order — handy when iterating with
// `Object.values(Models)` (see init.ts).

// Tier 1 — no FK deps
export { SetupStatus } from './schemas/setup-status.js'
export { User } from './schemas/user.js'
export { Organization } from './schemas/organization.js'
export { SystemSetting } from './schemas/system-setting.js'
export { SystemSettingAudit } from './schemas/system-setting-audit.js'
export { TaskEngineConfig } from './schemas/task-engine-config.js'
export { TaskEngineAudit } from './schemas/task-engine-audit.js'
export { ModelRouting } from './schemas/model-routing.js'

// Tier 2 — depend on Tier 1
export { EmailOtp } from './schemas/email-otp.js'
export { ApiKey } from './schemas/api-key.js'
export { ProviderAccount } from './schemas/provider-account.js'
export { Project } from './schemas/project.js'

// Tier 3 — depend on Project (mostly)
export { SessionHandoff } from './schemas/session-handoff.js'
export { AgentAck, agentAckId } from './schemas/agent-ack.js'
export { IndexJob } from './schemas/index-job.js'
export { ChangeEvent } from './schemas/change-event.js'
export { CodeSymbol } from './schemas/code-symbol.js'
export { CodeEdge } from './schemas/code-edge.js'
export { KnowledgeDocument } from './schemas/knowledge-document.js'
export { KnowledgeChunk } from './schemas/knowledge-chunk.js'
export { AgentMemory } from './schemas/agent-memory.js'

// Tier 4 — independent logs + reports
export { QueryLog } from './schemas/query-log.js'
export { UsageLog } from './schemas/usage-log.js'
export { LlmGatewayLog } from './schemas/llm-gateway-log.js'
export { QualityReport } from './schemas/quality-report.js'

// Re-export connection helpers for convenience.
export {
  connectMongoose,
  disconnectMongoose,
  getMongoose,
  isMongooseConnected,
  supportsTransactions,
} from './connection.js'

// Doc types — useful when typing function arguments. Keep these in a
// secondary list so they don't pollute the model namespace above.
export type { SetupStatusDoc } from './schemas/setup-status.js'
export type { UserDoc } from './schemas/user.js'
export type { OrganizationDoc } from './schemas/organization.js'
export type { SystemSettingDoc } from './schemas/system-setting.js'
export type { SystemSettingAuditDoc } from './schemas/system-setting-audit.js'
export type { TaskEngineConfigDoc } from './schemas/task-engine-config.js'
export type { TaskEngineAuditDoc } from './schemas/task-engine-audit.js'
export type { ModelRoutingDoc } from './schemas/model-routing.js'
export type { EmailOtpDoc } from './schemas/email-otp.js'
export type { ApiKeyDoc } from './schemas/api-key.js'
export type { ProviderAccountDoc } from './schemas/provider-account.js'
export type { ProjectDoc } from './schemas/project.js'
export type { SessionHandoffDoc } from './schemas/session-handoff.js'
export type { AgentAckDoc } from './schemas/agent-ack.js'
export type { IndexJobDoc } from './schemas/index-job.js'
export type { ChangeEventDoc } from './schemas/change-event.js'
export type { CodeSymbolDoc } from './schemas/code-symbol.js'
export type { CodeEdgeDoc } from './schemas/code-edge.js'
export type { KnowledgeDocumentDoc } from './schemas/knowledge-document.js'
export type { KnowledgeChunkDoc } from './schemas/knowledge-chunk.js'
export type { AgentMemoryDoc } from './schemas/agent-memory.js'
export type { QueryLogDoc } from './schemas/query-log.js'
export type { UsageLogDoc } from './schemas/usage-log.js'
export type { LlmGatewayLogDoc } from './schemas/llm-gateway-log.js'
export type { QualityReportDoc } from './schemas/quality-report.js'
