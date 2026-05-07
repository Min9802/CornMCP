// ─── Token estimation helpers for MCP telemetry ──────────────────────────
//
// We report two distinct numbers per tool call to the dashboard:
//
//   • computeTokens  — actual tokens the agent's LLM had to consume to send
//                      the request and ingest the response. Approximated as
//                      ⌈(inputBytes + outputBytes) / 4⌉ (OpenAI rule-of-thumb
//                      that 1 token ≈ 4 chars for English/code-mixed text).
//
//   • tokensSaved    — *estimated* tokens the agent would have spent if it
//                      had to obtain equivalent context without the MCP tool.
//                      For search/explore tools this is much higher than the
//                      compact MCP response. For pure write/lifecycle tools
//                      there is no meaningful baseline so saved = 0.
//
// The multiplier represents the assumed condense ratio: how many tokens of
// raw context the tool replaces per token returned. Conservative defaults —
// tune from real data via corn_tool_stats once we have a baseline.

const SAVED_MULTIPLIER: Record<string, number> = {
  // High-leverage explore tools: replace many file reads / grep dumps.
  corn_code_search: 5,
  corn_code_context: 5,
  corn_code_impact: 4,
  corn_cypher: 4,
  // Memory / knowledge retrieval: replaces re-reading past conversations
  // or external docs.
  corn_memory_search: 4,
  corn_knowledge_search: 4,
  // Change awareness: replaces git log + diff scanning.
  corn_detect_changes: 3,
  corn_changes: 3,
  // Lighter helpers: smaller but non-zero savings.
  corn_plan_quality: 2,
  corn_tool_stats: 2,
  // No savings — these are raw passthroughs or pure writes/lifecycle.
  // corn_code_read, corn_memory_store, corn_knowledge_store,
  // corn_session_start, corn_session_end, corn_quality_report,
  // corn_health, corn_list_repos → not listed → 0.
}

const CHARS_PER_TOKEN = 4

export function estimateComputeTokens(inputBytes: number, outputBytes: number): number {
  const total = Math.max(0, inputBytes) + Math.max(0, outputBytes)
  return Math.ceil(total / CHARS_PER_TOKEN)
}

export function estimateTokensSaved(tool: string, outputBytes: number): number {
  const m = SAVED_MULTIPLIER[tool] ?? 0
  if (m <= 1) return 0
  const outputTokens = Math.ceil(Math.max(0, outputBytes) / CHARS_PER_TOKEN)
  // baseline = m × outputTokens, actual = 1 × outputTokens, saved = (m-1) × outputTokens.
  return outputTokens * (m - 1)
}
