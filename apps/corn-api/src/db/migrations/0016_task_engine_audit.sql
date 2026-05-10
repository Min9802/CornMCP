-- Migration 0016 — Task Engine Config audit log (S6.1)
-- One row per *field* changed when admin updates a task_engine_config
-- entry. Mirrors the system_settings_audit pattern: append-only, kept
-- forever (admin can purge manually if needed). Used by the S6 UI to
-- show "who changed what / when" for compliance + rollback diagnosis.
--
-- Why per-field (not per-row): admin tweaks usually touch 1-2 fields
-- (engine, providerId), so a row-level snapshot would record every
-- unchanged column too — noisy and hard to filter. Per-field rows let
-- the UI render compact diffs.

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
