-- Phase S2 — Runtime configuration store
-- system_settings: keyed config with priority DB > env > default. Secrets
-- (is_secret=1) are wrapped in the AES-GCM envelope from S1's secrets layer
-- before being persisted. `default_value` is documentation/UI hint only — it
-- is NOT auto-applied at read time; getSetting() does env fallback if the
-- row is absent. Hot-reload happens via a 60s in-memory TTL cache.
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

-- system_settings_audit: append-only history. For is_secret=1 keys, both
-- old/new are stored as `••••<last4>` masks — never raw ciphertext or
-- plaintext, so admins can browse history without leaking secrets.
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
