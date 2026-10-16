-- 0022_drop_device_assignment.sql
-- Fase 2 / Dispositivos assignment retirement.
--
-- Drops the nullable forward-only FK `dispositivos.assigned_student_id`
-- (added by migration 0015) and its partial index. The marbete →
-- student FK (`marbetes.assigned_student_id`) is INTENTIONALLY left
-- alone — the marbete→student identity is the spine of the MFA chain
-- and is unrelated to the device binding this column once provided.
--
-- Rationale (from `odd/tasks/dispositivos-assignment-retirement.md`):
--   - The shared-device allowlist model treats the device as an
--     authorization factor (an approved hardware pool), NOT an
--     identity factor. The owner identity was historically encoded
--     in `dispositivos.assigned_student_id`, but the binding was
--     never consulted by the post-fase-1 MFA chain (it relies on the
--     marbete → student FK instead) so dropping the column is a
--     pure structural cleanup, not a behavioral change.
--   - The `audit_action` enum values `dispositivo.assign` /
--     `dispositivo.unassign` (added by migration 0016) are kept:
--     PostgreSQL cannot easily drop enum values AND historical
--     audit rows may reference them. Only the code that emitted
--     those actions is removed (the assign/unassign routes +
--     service methods + repository writes).
--
-- Idempotency: safe to re-apply. DROP INDEX IF EXISTS and
-- DROP COLUMN IF EXISTS let the runner no-op against a database
-- that already lost the column (e.g. the second migration run in
-- tests). No DEFAULT, no UPDATE, no CHECK constraint, no trigger
-- — this migration is purely a DROP.

BEGIN;

DROP INDEX IF EXISTS idx_dispositivos_assigned_student_id;

ALTER TABLE dispositivos DROP COLUMN IF EXISTS assigned_student_id;

COMMIT;