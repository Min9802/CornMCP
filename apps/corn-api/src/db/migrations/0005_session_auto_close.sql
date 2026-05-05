-- Add last_activity_at to session_handoffs for inactivity-based auto-close.
-- Backfill existing rows from created_at so first job pass doesn't blanket-close them.
ALTER TABLE session_handoffs ADD COLUMN last_activity_at TEXT;
UPDATE session_handoffs SET last_activity_at = COALESCE(last_activity_at, created_at);
CREATE INDEX IF NOT EXISTS idx_session_handoffs_status_activity
  ON session_handoffs(status, last_activity_at);
