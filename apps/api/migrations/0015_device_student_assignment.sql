-- 0015_device_student_assignment.sql
-- B1 / Canvas-bound device authorization prerequisite.
--
-- Adds a nullable forward-only FK from `dispositivos.assigned_student_id`
-- to `students_cache(id)` with `ON DELETE SET NULL` so revoking a student
-- from the cache (e.g. canvas-cache wipe) does not cascade into a
-- destructive device delete — the device stays as inventory, simply
-- reverts to "unassigned" until an admin re-binds it.
--
-- Approved product rules (B1 only — assignment logic lives in B2):
--   - One owner per device (the FK is single-valued, NOT a list).
--   - Multiple devices per student are allowed (no unique constraint on
--     assigned_student_id).
--   - Existing devices remain UNASSIGNED. No default value is supplied
--     and no backfill runs — every pre-existing row is left with
--     assigned_student_id = NULL until an admin explicitly assigns it.
--   - A revoked/inactive/missing student must never satisfy a security
--     access decision; the fail-closed check is the application layer's
--     responsibility, NOT the database (we do not encode revocation
--     truth in this FK because Canvas enrollment status is the source
--     of truth and lives in students_cache.is_active).
--
-- Idempotency: safe to re-apply. ADD COLUMN IF NOT EXISTS lets the
-- runner no-op the column add against a database that already has it
-- (e.g. the second migration run in tests). No DEFAULT, no UPDATE, no
-- CHECK constraint, no trigger — this migration is purely structural.

BEGIN;

ALTER TABLE dispositivos
  ADD COLUMN IF NOT EXISTS assigned_student_id BIGINT
    REFERENCES students_cache(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_dispositivos_assigned_student_id
  ON dispositivos(assigned_student_id)
  WHERE assigned_student_id IS NOT NULL;

COMMENT ON COLUMN dispositivos.assigned_student_id IS
  'Canvas-bound device owner. NULL = inventory only, no access rights. Application layer enforces active student + matching canvas_user_id + active device status before granting access (fail-closed).';

COMMIT;
