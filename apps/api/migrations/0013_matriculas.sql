-- 0013_matriculas.sql
-- WU v3 / "Asignación de marbetes" backend support.
--
-- Adds three building blocks that the new screen needs:
--   1. marbetes.assigned_by  (operator username captured at assign time)
--   2. 'marbete.assign_bulk' to the audit_action enum (one aggregate row
--      per /assign call regardless of pair count)
--   3. 'marbete.unassign'    to the audit_action enum (single-row
--      audit entry for the new /unassign endpoint)
--
-- ALTER TYPE ADD VALUE cannot run inside a multi-statement transaction
-- block on older PG, but the ADD VALUE IF NOT EXISTS pattern used by
-- 0008/0009/0010 is documented to work inside the runner's transaction
-- because the new enum labels are committed (via the runner's COMMIT)
-- before anything tries to insert a row referencing them. The runner
-- wraps every file in BEGIN/COMMIT so this file stays consistent with
-- the existing convention.
--
-- assigned_by mirrors actor_id: set on assign, cleared on unassign.
-- The column is nullable so the existing rows (none of which had a
-- tracked operator at write time) keep their pre-migration state and
-- the assignment-update SQL can write a NULL on unassign without
-- touching unrelated fields.

BEGIN;

ALTER TABLE marbetes
  ADD COLUMN IF NOT EXISTS assigned_by TEXT;

-- The new audit actions. Same caveat as 0008/0009/0010: ADD VALUE
-- IF NOT EXISTS inside a transaction is supported by the migration
-- runner; if you re-apply this file manually outside the runner,
-- run each ADD VALUE in its own transaction.
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'marbete.assign_bulk';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'marbete.unassign';

COMMIT;