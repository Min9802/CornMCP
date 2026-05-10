-- Migration 0015 — Task Engine Config (S5.1)
-- One row per registered MCP task. `engine='heuristic'` runs the
-- in-process pure-JS scorer (free, deterministic). `engine='llm'`
-- routes through the corn-api LLM Gateway with the configured
-- {provider, model, prompt_template} and falls back to heuristic on
-- error when `fallback_to_heuristic=1`.
--
-- Seeded with 10 tasks (S5.1 scope) all defaulting to `heuristic` so
-- the dispatcher behavior is unchanged after the migration runs. Admin
-- flips a row to `llm` via PATCH /api/system/task-engines/:taskName.

CREATE TABLE IF NOT EXISTS task_engine_config (
    task_name              TEXT PRIMARY KEY,
    engine                 TEXT NOT NULL DEFAULT 'heuristic' CHECK(engine IN ('heuristic','llm')),
    provider_id            TEXT,
    model                  TEXT,
    enabled                INTEGER NOT NULL DEFAULT 1,
    fallback_to_heuristic  INTEGER NOT NULL DEFAULT 1,
    prompt_template        TEXT,
    timeout_ms             INTEGER DEFAULT 30000,
    max_input_tokens       INTEGER DEFAULT 8000,
    max_output_tokens      INTEGER DEFAULT 1024,
    temperature            REAL DEFAULT 0.2,
    cache_ttl_sec          INTEGER DEFAULT 3600,
    cost_cap_usd_per_day   REAL DEFAULT 0,
    description            TEXT,
    updated_by             TEXT,
    updated_at             TEXT DEFAULT (datetime('now')),
    created_at             TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_engine_config_engine ON task_engine_config(engine);

-- Seed the 10 tasks the plan calls out in S7. All start as heuristic so
-- enabling LLM is opt-in per row; admin can flip via PATCH or the S6 UI.
-- INSERT OR IGNORE so re-running the migration on an already-seeded DB
-- (or one that has admin-edited rows) is a no-op.
INSERT OR IGNORE INTO task_engine_config (task_name, engine, description) VALUES
    ('plan_quality',          'heuristic', 'Score plans on 8 criteria (clarity/scope/risks/testing/reversibility/impact/dependencies/timeline). LLM mode rates each 0-10 instead of keyword-checking.'),
    ('auto_tags_for_memory',  'heuristic', 'Suggest tags for new memories. Heuristic = simple keyword extraction; LLM = semantic topic extraction.'),
    ('session_summary',       'heuristic', 'Summarize a session log into 2-4 sentences for handoff. Heuristic = first-N-chars truncation; LLM = abstractive summary.'),
    ('quality_report_assist', 'heuristic', 'Auto-fill the 4-dimension quality scores from a git diff + session log. Heuristic = simple rules; LLM = qualitative assessment.'),
    ('memory_dedup',          'heuristic', 'Detect duplicate memory entries. Heuristic = vector cosine threshold; LLM = semantic equivalence judge.'),
    ('code_search_rerank',    'heuristic', 'Rerank top-K code search results by relevance. Heuristic = score order; LLM = intent-aware rerank.'),
    ('anomaly_detection',     'heuristic', 'Flag anomalous query/cost patterns. Heuristic = static threshold; LLM = pattern recognition.'),
    ('token_count',           'heuristic', 'Count tokens for an arbitrary string. Heuristic = local BPE (TOKEN L2); LLM = provider tokenizer API as fallback.'),
    ('knowledge_dedup',       'heuristic', 'Detect duplicate knowledge documents. Same approach as memory_dedup.'),
    ('chat_assistant',        'heuristic', 'New MCP tool corn_chat. Heuristic = unsupported (returns error); LLM = full chat completion via gateway.');
