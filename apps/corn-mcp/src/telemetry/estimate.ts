// ─── Token estimation helpers for MCP telemetry ──────────────────────────
//
// We report two distinct numbers per tool call to the dashboard:
//
//   • computeTokens  — actual tokens the agent's LLM had to consume to send
//                      the request and ingest the response. Approximated via
//                      a language-aware chars-per-token ratio that adapts to
//                      English/code (~4), JSON-heavy payloads (~3.5),
//                      Vietnamese diacritics (~2.8), and CJK scripts (~2).
//                      Still a heuristic — see TOKEN_TRACKING_PLAN.md L2 for
//                      the real-BPE upgrade path.
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
  // Memory / knowledge writes: smaller — replaces re-typing the summary or
  // re-deriving the same lesson from logs.
  corn_memory_store: 1.5,
  corn_knowledge_store: 1.5,
  // Session lifecycle: session_start re-reads previous context, session_end
  // condenses it for handoff.
  corn_session_start: 2,
  corn_session_end: 1.5,
  // Quality / planning helpers.
  corn_quality_report: 1.5,
  corn_plan_quality: 2,
  // Change awareness: replaces git log + diff scanning.
  corn_detect_changes: 3,
  corn_changes: 3,
  // Stats tool itself.
  corn_tool_stats: 2,
  // No savings — these are raw passthroughs or pure reads.
  // corn_code_read, corn_health, corn_list_repos → not listed → 0.
}

// Min response size (UTF-16 chars) below which we treat the result as empty
// or error and skip savings entirely. Avoids inflating metrics when a tool
// returns "no hits" or a tiny error envelope.
const MIN_SAVED_OUTPUT_CHARS = 200

// Upper bound on the savings multiplier vs. the actual output tokens. Keeps
// pathological responses (e.g. 5MB code dumps) from blowing up the metric.
const MAX_SAVED_RATIO = 10

// Regex to detect CJK ideographs / kana / hangul.
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

// Vietnamese diacritics (covers tones + ô/ă/đ/etc.). Case-insensitive.
const VI_DIACRITIC_RE = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/giu

// JSON syntax characters: braces, brackets, quotes, colon, comma.
const JSON_SYNTAX_RE = /[{}\[\]":,]/g

/**
 * Pick a chars-per-token ratio based on the surface form of `text`.
 *
 * Language-aware heuristic (still cheap, no tokenizer dep):
 *   • CJK script ≥ 10% of chars   → 2.0   (each CJK char usually ≈ 1 token)
 *   • Vietnamese diacritics ≥ 5%  → 2.8   (UTF-8 multi-byte + token-per-syllable)
 *   • JSON-heavy syntax ≥ 25%     → 3.5   (lots of single-token punctuation)
 *   • Default                     → 4.0   (English / code / markdown)
 */
export function detectCharsPerToken(text: string): number {
  if (!text) return 4
  const len = text.length

  const cjkMatches = text.match(CJK_RE)
  if (cjkMatches && cjkMatches.length / len >= 0.1) return 2

  const viMatches = text.match(VI_DIACRITIC_RE)
  if (viMatches && viMatches.length / len >= 0.05) return 2.8

  if (len >= 50) {
    const jsonMatches = text.match(JSON_SYNTAX_RE)
    if (jsonMatches && jsonMatches.length / len >= 0.25) return 3.5
  }

  return 4
}

/**
 * Count tokens for a single text chunk using the language-aware ratio.
 * Returns 0 for empty input. Exported for tests and reuse.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0
  const ratio = detectCharsPerToken(text)
  return Math.ceil(text.length / ratio)
}

/**
 * Estimate tokens the agent's LLM had to consume for one MCP request.
 * Each side gets its own ratio (input may be JSON params, output may be
 * code/markdown).
 */
export function estimateComputeTokens(inputText: string, outputText: string): number {
  return estimateTokenCount(inputText) + estimateTokenCount(outputText)
}

/**
 * Estimate tokens the agent would have spent obtaining equivalent context
 * without the MCP tool. Skips when output is empty/tiny (likely no-hit /
 * error envelope) and caps the multiplier to `MAX_SAVED_RATIO`.
 */
export function estimateTokensSaved(tool: string, outputText: string): number {
  if (!outputText || outputText.length < MIN_SAVED_OUTPUT_CHARS) return 0
  const m = SAVED_MULTIPLIER[tool] ?? 0
  if (m <= 1) return 0
  const outputTokens = estimateTokenCount(outputText)
  // baseline = m × outputTokens, actual = 1 × outputTokens, saved = (m-1) × outputTokens.
  const ratio = Math.min(m - 1, MAX_SAVED_RATIO)
  return outputTokens * ratio
}
