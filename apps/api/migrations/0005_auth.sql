-- 0005_auth.sql
-- Users (admin/operator/auditor) + opaque session tokens.
-- Sessions are looked up by token; cookie carries the token, server resolves it to user.
-- Passwords stored as bcrypt cost-12 hashes (cost is set at the application layer).

-- Idempotency note: this migration uses IF NOT EXISTS / DO-blocks so it is
-- safe to re-apply against a database that already has these objects (for
-- example, when an integration test leaves users/sessions behind and the
-- next suite re-runs the runner from scratch). In production each migration
-- runs exactly once via _migrations tracking, so the IF NOT EXISTS is a
-- no-op — it only matters for the test workflow.

BEGIN;

DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('admin', 'operator', 'auditor');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id              BIGSERIAL    PRIMARY KEY,
  email           TEXT         NOT NULL UNIQUE,
  password_hash   TEXT         NOT NULL,
  role            user_role    NOT NULL DEFAULT 'operator',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ,
  disabled_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role) WHERE disabled_at IS NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT         PRIMARY KEY,         -- opaque token (base64url 32 bytes)
  user_id       BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at    TIMESTAMPTZ  NOT NULL,
  ip            INET,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

COMMENT ON TABLE users IS
  'Backoffice operators. role: admin (full), operator (read+limited write), auditor (read-only audit).';

COMMENT ON TABLE sessions IS
  'Opaque session tokens. Lookup by id is the auth path. CASCADE delete on user removal.';

COMMIT;
