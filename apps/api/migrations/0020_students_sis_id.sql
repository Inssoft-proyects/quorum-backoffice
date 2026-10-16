-- 0020_students_sis_id.sql
-- Synthetic high-privacy students: identify a `students_cache` row
-- by the SIS matrícula alone (no personal data).
--
-- The cache was originally shaped around full personal data:
--   - `canvas_user_id BIGINT UNIQUE`  (the wire key)
--   - `full_name TEXT NOT NULL`        (Canvas-side display name)
--   - `email   TEXT NOT NULL`          (Canvas-side email)
-- and that contract forced every row to carry a real human name +
-- email. For synthetic test-data seeding (operators spinning up
-- fixtures for the M0 / M1 / B1 / B5 surfaces) that constraint is
-- the wrong default: the cache becomes a PII sink just to host
-- fake rows, and tests start leaking names that look real.
--
-- This migration makes the cache PII-free for the synthetic case
-- without changing the shape of any existing row:
--
--   1. `sis_id` is added as a NULLABLE column with a UNIQUE partial
--      index. The matrícula is the *identifier* the synthetic row
--      keys by; the canvas_user_id stays the wire key. The partial
--      predicate `WHERE sis_id IS NOT NULL` keeps the unique index
--      small (it does not index NULL rows) and lets legacy rows
--      (sis_id IS NULL) coexist freely. A second row with the
--      same matrícula is rejected at INSERT time, so the
--      B1 / B5 SIS lookup can trust the index for fail-closed
--      duplicate detection.
--
--   2. `full_name` and `email` drop their NOT NULL constraints.
--      Existing rows keep their values (this is purely structural,
--      no backfill, no rewrite). New rows may be inserted with
--      NULLs, which is the synthetic test-data shape.
--
-- Idempotency: every statement uses IF NOT EXISTS or is itself
-- idempotent (ALTER COLUMN ... DROP NOT NULL is a no-op on a
-- column that is already nullable). The 0015 / 0011 / 0006
-- pattern is mirrored so a re-run of the migration runner is a
-- safe no-op.

BEGIN;

ALTER TABLE students_cache
  ADD COLUMN IF NOT EXISTS sis_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_students_sis_id
  ON students_cache(sis_id)
  WHERE sis_id IS NOT NULL;

ALTER TABLE students_cache
  ALTER COLUMN full_name DROP NOT NULL;

ALTER TABLE students_cache
  ALTER COLUMN email DROP NOT NULL;

COMMENT ON COLUMN students_cache.sis_id IS
  'SIS matrícula (6-char uppercase alnum). NULL = legacy row inserted before 0020, or a row whose SIS source is not yet known. UNIQUE is partial (WHERE sis_id IS NOT NULL) so NULL values are not indexed and may repeat freely. The synthetic high-privacy test-data flow uses ONLY canvas_user_id + sis_id with NULL full_name / email; this lets the cache host realistic-shaped fixtures without carrying PII.';

COMMENT ON COLUMN students_cache.full_name IS
  'Canvas-side display name. NULLable since 0020: synthetic high-privacy students carry only canvas_user_id + sis_id and intentionally omit PII.';

COMMENT ON COLUMN students_cache.email IS
  'Canvas-side email. NULLable since 0020: synthetic high-privacy students carry only canvas_user_id + sis_id and intentionally omit PII.';

COMMIT;
