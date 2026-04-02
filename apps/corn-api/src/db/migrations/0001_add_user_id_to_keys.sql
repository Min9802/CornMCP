-- Add user_id to api_keys, provider_accounts, organizations, knowledge_documents, quality_reports
ALTER TABLE api_keys ADD COLUMN user_id TEXT;
ALTER TABLE provider_accounts ADD COLUMN user_id TEXT;
ALTER TABLE organizations ADD COLUMN user_id TEXT;
ALTER TABLE knowledge_documents ADD COLUMN user_id TEXT;
ALTER TABLE quality_reports ADD COLUMN user_id TEXT;
