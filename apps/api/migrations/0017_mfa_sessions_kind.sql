-- 0017_mfa_sessions_kind.sql
-- M1 / MFA student-session support.
--
-- Extends the existing `sessions` table (created in 0005_auth.sql) so it
-- can carry a second kind of session: the MFA student session, keyed by
-- `canvas_user_id` instead of a `users.id` FK. The same cookie shape
-- (`__Host-mfa_sid`) is reused, but the `user_id` FK is left NULL for
-- the new kind (the student is identified by `canvas_user_id` instead).
--
-- Schema decisions:
--
--   - `user_id` is made NULLABLE (was NOT NULL) so a `kind='student'`
--     row can identify its owner by `canvas_user_id` without
--     inventing a synthetic `users.id` (the student is NOT a
--     BackOffice operator and has no `users` row). The CHECK
--     constraint below guarantees that `kind='user'` rows still
--     carry a non-NULL `user_id` so the existing auth surface
--     is unchanged.
--   - `kind` is a TEXT column with a CHECK constraint over the closed
--     set ('user', 'student'). We deliberately do NOT promote it to a
--     Postgres enum because the existing `sessions` table does not use
--     an enum for any of its discriminator-shaped columns, and a CHECK
--     keeps the migration additive and re-runnable from the test
--     runner that wipes the schema between suites.
--   - DEFAULT 'user' is safe because every existing row was issued
--     for a BackOffice operator (the previous auth surface). New
--     MFA sessions are inserted with `kind='student'` explicitly so
--     a `RETURNING` from the INSERT always reports the right shape.
--   - The role for a student session is `student` by definition of
--     `kind='student'`; we do NOT add a redundant `role` column
--     because the discriminator + the lookup table is already
--     sufficient (`kind='user'` joins `users.role`, `kind='student'`
--     implies `role='student'`). Adding a `role` column would
--     invite drift between `users.role` and `sessions.role`.
--   - `canvas_user_id` is a nullable bigint with a FK to
--     `students_cache(canvas_user_id)` and `ON DELETE SET NULL`.
--     Mirrors the dispositivo ↔ student precedent (migration 0015):
--     a Canvas cache wipe must NEVER cascade into a destructive
--     session delete — the session simply loses its student FK and
--     the MFA session route will report the session as unknown the
--     next time it is consulted. (Application-layer enforcement;
--     the DB just keeps the referent optional.)
--   - The CHECK is mutually exclusive: a kind='user' row MUST have
--     `user_id IS NOT NULL AND canvas_user_id IS NULL`, a
--     kind='student' row MUST have `user_id IS NULL AND
--     canvas_user_id IS NOT NULL`. A row that satisfies neither is
--     rejected at INSERT time; a row that satisfies both is also
--     rejected (a session can only be one kind).
--
-- Idempotency: safe to re-apply. ADD COLUMN IF NOT EXISTS, ALTER
-- COLUMN ... DROP NOT NULL (idempotent), ADD CONSTRAINT via DO
-- block, and CREATE INDEX IF NOT EXISTS. The test runner drops
-- and re-creates the table between suites, so on a fresh DB the
-- migration just runs the ADD COLUMN + DROP NOT NULL + ADD
-- CONSTRAINT + CREATE INDEX paths.

BEGIN;

-- 1) Drop NOT NULL on user_id. Wrapped in DO block so the second
--    apply of this migration (against a database that already
--    ran the first apply) is a no-op rather than a 42704.
DO $$ BEGIN
  ALTER TABLE sessions ALTER COLUMN user_id DROP NOT NULL;
EXCEPTION
  WHEN undefined_column THEN NULL;
END $$;

-- 2) Add the kind discriminator. Defaults to 'user' for back-compat
--    with the existing operator session rows.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'user';

-- 3) Add the canvas_user_id nullable FK.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS canvas_user_id BIGINT
    REFERENCES students_cache(canvas_user_id) ON DELETE SET NULL;

-- CHECK constraint (idempotent via DO block). The constraint name is
-- stable so re-running the migration is a no-op when it already
-- exists. The mutually-exclusive shape:
--   - kind='user'    → user_id MUST be NOT NULL AND
--                      canvas_user_id MUST be NULL
--   - kind='student' → user_id MUST be NULL AND
--                      canvas_user_id MUST be NOT NULL
-- Any row that satisfies neither is rejected at INSERT time; any row
-- that satisfies both is also rejected (a session can only be one
-- kind).
DO $$ BEGIN
  ALTER TABLE sessions
    ADD CONSTRAINT ck_sessions_kind_user_canvas
    CHECK (
      (kind = 'user'    AND user_id IS NOT NULL AND canvas_user_id IS NULL)
      OR (kind = 'student' AND user_id IS NULL      AND canvas_user_id IS NOT NULL)
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_sessions_kind
  ON sessions(kind);

CREATE INDEX IF NOT EXISTS idx_sessions_canvas_user_id
  ON sessions(canvas_user_id)
  WHERE canvas_user_id IS NOT NULL;

COMMENT ON COLUMN sessions.kind IS
  'Discriminator for the session shape: ''user'' (BackOffice operator, keyed by user_id) or ''student'' (MFA-authenticated Canvas student, keyed by canvas_user_id). Defaults to ''user'' for back-compat with the existing operator session rows.';

COMMENT ON COLUMN sessions.canvas_user_id IS
  'Canvas LMS user id for kind=''student'' sessions. NULL for kind=''user'' sessions. ON DELETE SET NULL so a Canvas cache wipe never destroys session rows; the MFA session route will treat the session as unknown on next lookup.';

COMMIT;
