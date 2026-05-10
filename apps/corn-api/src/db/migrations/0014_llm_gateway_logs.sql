-- Migration 0014 — LLM Gateway audit + cost log (S4.5)
-- Every call that enters `chatComplete()` lands here (success OR error).
-- Cost cap enforcement SUMs `cost_usd WHERE error IS NULL` so errored
-- rows do not count toward the daily budget. `cached=1` rows have
-- cost_usd=0 and latency_ms=0 — they still track usage for hit-ratio
-- analytics but don't skew cost. Virtual env-fallback providers write
-- `provider_id='env:<provider>'` so the ops dashboard can filter them.

CREATE TABLE IF NOT EXISTS llm_gateway_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    task_name       TEXT,
    provider_id     TEXT,
    provider        TEXT,
    model           TEXT,
    input_tokens    INTEGER DEFAULT 0,
    output_tokens   INTEGER DEFAULT 0,
    cost_usd        REAL DEFAULT 0,
    latency_ms      INTEGER DEFAULT 0,
    cached          INTEGER DEFAULT 0,
    error           TEXT,
    user_id         TEXT,
    session_id      TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_llm_gateway_logs_created  ON llm_gateway_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_gateway_logs_task     ON llm_gateway_logs(task_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_gateway_logs_provider ON llm_gateway_logs(provider_id, created_at DESC);
