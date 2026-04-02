-- Make users.password_hash nullable (required for Google OAuth users)
-- SQLite does not support ALTER COLUMN, so we rebuild the table.
CREATE TABLE users_new (
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

INSERT INTO users_new
    SELECT id, email, password_hash, name, role, is_active, email_verified, google_id, avatar_url, created_at, updated_at
    FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;
