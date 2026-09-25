-- 0011_backoffice_username.sql
-- Username + pre-issued Quorum OTP login.
--
-- Adds a nullable unique `users.username` column so BackOffice operators
-- can log in with a username bound to their existing local role. Email
-- and role columns stay untouched: roles remain BackOffice-authored and
-- are NOT inferred from any external source.
--
-- Important non-goals (user-confirmed):
--   - Production username assignments for existing BackOffice accounts
--     are NOT supplied by this migration. The column is created NULL-able
--     and the migration does not backfill from email (we cannot reliably
--     derive a canonical BackOffice username from an email address).
--   - Login remains impossible for accounts where `username IS NULL`; the
--     application surfaces a stable `user_unmapped` error so the missing
--     mapping is observable in the audit log.
--
-- Idempotency: safe to re-apply. The column add uses ADD COLUMN IF NOT
-- EXISTS; the unique partial index uses CREATE INDEX IF NOT EXISTS so
-- the migration is also re-runnable from the test runner that wipes
-- tables between suites.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS username TEXT;

-- Username must be case-insensitively unique when present. Partial unique
-- index over NOT NULL keeps the constraint local (multiple NULLs remain
-- legal in PostgreSQL) and supports the legitimate "no username yet"
-- state for legacy accounts that pre-date the username rollout.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username_lower
  ON users (LOWER(username))
  WHERE username IS NOT NULL;

-- Username format guard. Mirrors the application-layer validator in
-- shared/src/dto/auth.ts: 3-32 chars, alnum + dash/underscore/dot,
-- case-insensitive (lowercased on lookup).
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS ck_users_username_format;
ALTER TABLE users
  ADD CONSTRAINT ck_users_username_format
  CHECK (
    username IS NULL
    OR (
      LENGTH(username) BETWEEN 3 AND 32
      AND username ~ '^[A-Za-z0-9._-]+$'
    )
  );

COMMENT ON COLUMN users.username IS
  'BackOffice canonical login identifier. NULL until assigned (production rollout blocks until existing accounts are mapped). Roles are not inferred from external sources.';

COMMIT;
