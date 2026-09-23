-- 0002_marbetes.sql
-- Physical security badges ("marbetes") with QR bicapa / lenticular codes.
-- Codes are stored as sha256 hashes; public_uid is the operator-facing id.
-- One active marbete per student at any time (unique partial index).

BEGIN;

CREATE TYPE marbete_status AS ENUM ('active', 'inactive', 'revoked');

CREATE TABLE marbetes (
  id                    BIGSERIAL     PRIMARY KEY,
  public_uid            TEXT          NOT NULL UNIQUE,
  code_hash             TEXT          NOT NULL,
  status                marbete_status NOT NULL DEFAULT 'active',
  assigned_student_id   BIGINT        REFERENCES students_cache(id) ON DELETE SET NULL,
  assigned_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by            TEXT          NOT NULL,
  deleted_at            TIMESTAMPTZ,
  deletion_reason       TEXT,
  CHECK (code_hash ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX uq_marbete_active_per_student
  ON marbetes(assigned_student_id)
  WHERE status = 'active' AND deleted_at IS NULL;

CREATE INDEX idx_marbetes_status    ON marbetes(status);
CREATE INDEX idx_marbetes_assigned  ON marbetes(assigned_student_id);
CREATE INDEX idx_marbetes_deleted   ON marbetes(deleted_at);

COMMENT ON TABLE marbetes IS
  'Physical security badges. Soft-deleted via deleted_at + deletion_reason for audit trail.';

COMMIT;
