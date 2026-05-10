-- Phase S1 — Secrets layer
-- Add a flag so the migration sweep (apps/corn-api/scripts/migrate-encrypt-keys.ts)
-- can quickly find rows that still hold plain-text api_key. The actual
-- encryption happens in Node (AES-GCM) — SQL only tracks the rollout state.
--   api_key_encrypted = 0 → still plain text (or NULL)
--   api_key_encrypted = 1 → wrapped in `enc:v1:<iv>:<tag>:<ct>` envelope
-- Migration runner ignores `duplicate column` errors so this is idempotent.
ALTER TABLE provider_accounts ADD COLUMN api_key_encrypted INTEGER DEFAULT 0;
