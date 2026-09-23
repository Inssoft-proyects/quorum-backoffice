-- 0004_audit.sql
-- Append-only audit log of every privileged action in the backoffice.
-- WU5 enforces UPDATE/DELETE from API; this migration REVOKEs those
-- privileges at the SQL level so even superusers must DROP/RECREATE to
-- tamper (which itself is auditable).

BEGIN;

CREATE TYPE audit_action AS ENUM (
  'marbete.create',
  'marbete.update',
  'marbete.delete',
  'marbete.assign',
  'dispositivo.create',
  'dispositivo.update',
  'dispositivo.revoke',
  'auth.login',
  'auth.logout',
  'auth.failed'
);

CREATE TABLE audit_log (
  id           BIGSERIAL    PRIMARY KEY,
  occurred_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  actor_id     TEXT         NOT NULL,
  actor_email  TEXT,
  action       audit_action NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  before_jsonb JSONB,
  after_jsonb  JSONB,
  otp_id       TEXT,
  ip           INET,
  user_agent   TEXT
);

CREATE INDEX idx_audit_occurred ON audit_log(occurred_at DESC);
CREATE INDEX idx_audit_entity   ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_action   ON audit_log(action);
CREATE INDEX idx_audit_actor    ON audit_log(actor_id);

COMMENT ON TABLE audit_log IS
  'Append-only audit trail. UPDATE and DELETE are revoked from PUBLIC; writes require INSERT privilege only.';

REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM PUBLIC;

COMMIT;
