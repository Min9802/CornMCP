CREATE TABLE IF NOT EXISTS setup_status (
    id INTEGER PRIMARY KEY DEFAULT 1,
    completed BOOLEAN DEFAULT 0,
    completed_at TEXT
);

-- ── Users ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
    is_active INTEGER NOT NULL DEFAULT 1,
    email_verified INTEGER NOT NULL DEFAULT 0,
    google_id TEXT UNIQUE,
    avatar_url TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ── Email OTPs ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_otps (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    otp_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'all',
    permissions TEXT,
    project_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT,
    last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS query_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    params TEXT,
    latency_ms INTEGER,
    status TEXT DEFAULT 'ok',
    error TEXT,
    project_id TEXT,
    input_size INTEGER DEFAULT 0,
    output_size INTEGER DEFAULT 0,
    compute_tokens INTEGER DEFAULT 0,
    tokens_saved INTEGER DEFAULT 0,
    compute_model TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_handoffs (
    id TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL,
    to_agent TEXT,
    project TEXT NOT NULL,
    task_summary TEXT NOT NULL,
    context TEXT NOT NULL,
    priority INTEGER DEFAULT 5,
    status TEXT DEFAULT 'pending',
    claimed_by TEXT,
    project_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_activity_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT
);

CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    git_repo_url TEXT,
    git_provider TEXT,
    indexed_at TEXT,
    indexed_symbols INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(org_id, slug)
);

CREATE TABLE IF NOT EXISTS usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    project_id TEXT,
    request_type TEXT DEFAULT 'chat',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS provider_accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    auth_type TEXT DEFAULT 'api_key',
    api_base TEXT NOT NULL,
    api_key TEXT,
    api_key_encrypted INTEGER DEFAULT 0,
    status TEXT DEFAULT 'enabled',
    capabilities TEXT DEFAULT '["chat"]',
    models TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ── System Settings (S2) ───────────────────────────────
CREATE TABLE IF NOT EXISTS system_settings (
    key           TEXT PRIMARY KEY,
    value         TEXT,
    is_secret     INTEGER NOT NULL DEFAULT 0,
    category      TEXT NOT NULL DEFAULT 'general',
    description   TEXT,
    default_value TEXT,
    updated_by    TEXT,
    updated_at    TEXT DEFAULT (datetime('now')),
    created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_system_settings_category ON system_settings(category);

CREATE TABLE IF NOT EXISTS system_settings_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key        TEXT NOT NULL,
    old_value  TEXT,
    new_value  TEXT,
    action     TEXT NOT NULL DEFAULT 'set',
    changed_by TEXT,
    changed_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_system_settings_audit_key ON system_settings_audit(key, changed_at DESC);

-- ── LLM Gateway logs (S4.5) ───────────────────────────
-- Mirror of migration 0014 for fresh databases. One row per chatComplete()
-- call (success OR error). cost_usd is 0 for cached hits + error rows.
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

-- ── Task Engine Config (S5.1) ─────────────────────────
-- Mirror of migration 0015 for fresh databases. One row per registered
-- MCP task. Heuristic vs LLM toggle + per-task LLM knobs (provider,
-- model, prompt template, budget cap). Default seed all heuristic so
-- the dispatcher behavior is opt-in to LLM per row.
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

-- ── Task Engine audit (S6.1) ──────────────────────────
-- Mirror of migration 0016 for fresh databases. One row per *field*
-- changed by `updateTaskEngineConfig()`. Append-only; admin UI renders
-- diffs from this table.
CREATE TABLE IF NOT EXISTS task_engine_audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_name   TEXT NOT NULL,
    field       TEXT NOT NULL,
    old_value   TEXT,
    new_value   TEXT,
    action      TEXT NOT NULL DEFAULT 'update' CHECK(action IN ('update','test','reset')),
    changed_by  TEXT,
    changed_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_engine_audit_task   ON task_engine_audit(task_name, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_engine_audit_recent ON task_engine_audit(changed_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source TEXT DEFAULT 'manual',
    source_agent_id TEXT,
    project_id TEXT,
    tags TEXT DEFAULT '[]',
    status TEXT DEFAULT 'active',
    hit_count INTEGER DEFAULT 0,
    chunk_count INTEGER DEFAULT 0,
    content_preview TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Dashboard preview layer for memories stored by MCP into local mem9 vector DB.
-- Real vector data lives in apps/corn-mcp/data/mem9-vectors.db; this table is
-- only for list/audit/delete from the web dashboard.
CREATE TABLE IF NOT EXISTS agent_memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    content_preview TEXT,
    agent_id TEXT,
    project_id TEXT,
    branch TEXT,
    tags TEXT DEFAULT '[]',
    user_id TEXT,
    hit_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quality_reports (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    agent_id TEXT NOT NULL,
    session_id TEXT,
    gate_name TEXT NOT NULL,
    score_build INTEGER NOT NULL DEFAULT 0,
    score_regression INTEGER NOT NULL DEFAULT 0,
    score_standards INTEGER NOT NULL DEFAULT 0,
    score_traceability INTEGER NOT NULL DEFAULT 0,
    score_total INTEGER NOT NULL DEFAULT 0,
    grade TEXT NOT NULL DEFAULT 'F' CHECK(grade IN ('A','B','C','D','F')),
    passed BOOLEAN NOT NULL DEFAULT 0,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- ── Index Jobs ──
CREATE TABLE IF NOT EXISTS index_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    branch TEXT DEFAULT 'main',
    status TEXT DEFAULT 'pending',       -- pending | cloning | analyzing | ingesting | done | error
    progress INTEGER DEFAULT 0,          -- 0-100
    total_files INTEGER DEFAULT 0,
    symbols_found INTEGER DEFAULT 0,
    log TEXT,
    error TEXT,
    commit_hash TEXT,
    commit_message TEXT,
    triggered_by TEXT DEFAULT 'manual',
    mem9_status TEXT,
    mem9_chunks INTEGER DEFAULT 0,
    mem9_progress INTEGER DEFAULT 0,
    mem9_total_chunks INTEGER DEFAULT 0,
    docs_knowledge_status TEXT,
    docs_knowledge_count INTEGER DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- ── Model Routing (fallback chains per purpose) ──
CREATE TABLE IF NOT EXISTS model_routing (
    purpose TEXT PRIMARY KEY,            -- "chat" | "embedding" | "code"
    chain TEXT NOT NULL DEFAULT '[]',    -- JSON: [{"accountId":"...","model":"gpt-5.4-mini"},...]
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ── Change Events (cross-agent change awareness) ──
CREATE TABLE IF NOT EXISTS change_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    branch TEXT NOT NULL,
    agent_id TEXT,
    commit_sha TEXT,
    commit_message TEXT,
    files_changed TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- ── Agent Acknowledgements ──
CREATE TABLE IF NOT EXISTS agent_ack (
    agent_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    last_seen_event_id TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (agent_id, project_id)
);

-- ── Knowledge Chunks ──
CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    char_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

-- ── Code Knowledge Graph (AST Engine) ──
CREATE TABLE IF NOT EXISTS code_symbols (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    exported BOOLEAN DEFAULT 0,
    signature TEXT,
    doc_comment TEXT,
    parent_symbol_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS code_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_symbol_id TEXT NOT NULL REFERENCES code_symbols(id) ON DELETE CASCADE,
    target_symbol_id TEXT NOT NULL REFERENCES code_symbols(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    file_path TEXT,
    line_number INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_symbols_project ON code_symbols(project_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON code_symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON code_symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON code_symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_parent ON code_symbols(parent_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_source ON code_edges(source_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON code_edges(target_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON code_edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_project ON code_edges(project_id);

CREATE INDEX IF NOT EXISTS idx_query_logs_created ON query_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_logs_agent ON query_logs(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quality_reports_project ON quality_reports(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quality_reports_agent ON quality_reports(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_docs_project ON knowledge_documents(project_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_agent_memories_agent ON agent_memories(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_memories_project ON agent_memories(project_id);
CREATE INDEX IF NOT EXISTS idx_agent_memories_user ON agent_memories(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_memories_project_branch ON agent_memories(project_id, branch);
CREATE INDEX IF NOT EXISTS idx_change_events_project ON change_events(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_index_jobs_project ON index_jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_handoffs_status_activity ON session_handoffs(status, last_activity_at);

-- Default data
INSERT OR IGNORE INTO setup_status (id, completed) VALUES (1, 0);
INSERT OR IGNORE INTO organizations (id, name, slug, description)
VALUES ('org-default', 'Personal', 'personal', 'Default personal organization');

