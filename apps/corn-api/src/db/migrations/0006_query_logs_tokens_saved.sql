-- Add tokens_saved to query_logs so dashboard can split actual compute usage
-- (compute_tokens, already present) from estimated tokens saved by using MCP.
ALTER TABLE query_logs ADD COLUMN tokens_saved INTEGER DEFAULT 0;
