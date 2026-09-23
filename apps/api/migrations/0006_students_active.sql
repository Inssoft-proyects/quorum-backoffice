-- 0006_students_active.sql
-- Tracks whether a student is still active in Canvas. The marbetes
-- service uses this to reject assignments to students who have
-- graduated, withdrawn, or otherwise become inactive.

BEGIN;

ALTER TABLE students_cache
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_students_active
  ON students_cache(canvas_user_id)
  WHERE is_active = TRUE;

COMMENT ON COLUMN students_cache.is_active IS
  'Mirrors Canvas enrollment status. False when the student has graduated, withdrawn, or is otherwise not currently enrolled.';

COMMIT;
