-- Add agent_memories table for dashboard preview of MCP-stored memories.
-- Real vector data lives in MCP's local mem9-vectors.db; this table is the
-- queryable preview layer so the web dashboard can list/audit/delete entries.
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

CREATE INDEX IF NOT EXISTS idx_agent_memories_agent ON agent_memories(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_memories_project ON agent_memories(project_id);
CREATE INDEX IF NOT EXISTS idx_agent_memories_user ON agent_memories(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_memories_project_branch ON agent_memories(project_id, branch);
