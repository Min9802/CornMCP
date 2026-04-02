-- Add email_verified column to users
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
