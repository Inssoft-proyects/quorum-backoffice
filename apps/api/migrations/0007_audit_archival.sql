-- 0007_audit_archival.sql
-- Polish WU v3 / WU #6 audit_log archival policy.
--
-- Adds a destination table audit_log_archive and a SQL function
-- archive_audit_log(retention_days integer) that moves rows older than
-- retention_days from audit_log into audit_log_archive.
--
-- The function is SECURITY DEFINER because audit_log has
--   REVOKE UPDATE, DELETE, TRUNCATE FROM PUBLIC
-- in migration 0004, and the archive job needs to bypass that revoke.
-- The function is owned by the migration user (typically the table owner),
-- so DELETE works.
--
-- Run schedule is documented in RUNBOOK.md under "Audit log archival".

BEGIN;

-- 1. Archive table: same shape as audit_log (LIKE ... INCLUDING DEFAULTS
--    copies column defaults), plus an archived_at column. The actual
--    audit_log schema uses `occurred_at` (not `created_at`) and includes
--    `actor_email`; both are preserved here so the archive INSERT lines
--    up column-for-column.
CREATE TABLE IF NOT EXISTS audit_log_archive (LIKE audit_log INCLUDING DEFAULTS);
ALTER TABLE audit_log_archive
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_audit_log_archive_occurred_at
  ON audit_log_archive(occurred_at);

-- 2. Grant the app role read+insert+delete on the archive table.
--    Replace 'quorum_app' with the project's standard app role if it
--    differs; check apps/api/migrations/*.sql or apps/api/src/config.ts
--    to confirm the role name.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'quorum_app') THEN
    GRANT SELECT, INSERT, DELETE ON audit_log_archive TO quorum_app;
  END IF;
END $$;

-- 3. The archive function. SELECTs the archive cutoff using the actual
--    `occurred_at` column, then DELETE ... RETURNING + INSERT into the
--    archive table in a single statement. Returns the number of rows
--    moved.
CREATE OR REPLACE FUNCTION archive_audit_log(retention_days integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  cutoff timestamptz := NOW() - (retention_days || ' days')::interval;
  moved_rows integer;
BEGIN
  WITH deleted AS (
    DELETE FROM audit_log
    WHERE occurred_at < cutoff
    RETURNING *
  )
  INSERT INTO audit_log_archive
    (id, actor_id, actor_email, action, entity_type, entity_id,
     before_jsonb, after_jsonb, otp_id, ip, user_agent,
     occurred_at, archived_at)
  SELECT id, actor_id, actor_email, action, entity_type, entity_id,
         before_jsonb, after_jsonb, otp_id, ip, user_agent,
         occurred_at, NOW()
  FROM deleted;

  GET DIAGNOSTICS moved_rows = ROW_COUNT;
  RETURN moved_rows;
END;
$$;

-- 4. Only the migration owner should run the function (and admins).
--    Revoke from PUBLIC, grant to a maintenance role if one exists.
REVOKE ALL ON FUNCTION archive_audit_log(integer) FROM PUBLIC;

COMMIT;