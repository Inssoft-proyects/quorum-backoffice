-- 0001_init.sql
-- Read-only snapshot of Canvas LMS students used by the backoffice.
-- WU3 hydrates this via the canvas-client from portal-api.
-- WU3 also defines the periodic refresh policy.

BEGIN;

CREATE TABLE students_cache (
  id              BIGSERIAL PRIMARY KEY,
  canvas_user_id  BIGINT      NOT NULL UNIQUE,
  full_name       TEXT        NOT NULL,
  email           TEXT        NOT NULL,
  last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_students_canvas_id ON students_cache(canvas_user_id);
CREATE INDEX idx_students_email     ON students_cache(email);

COMMENT ON TABLE students_cache IS
  'Read-through cache of Canvas LMS students. Source of truth lives in Canvas.';

COMMIT;
