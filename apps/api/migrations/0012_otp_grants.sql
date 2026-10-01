-- 0012_otp_grants.sql
-- 20-minute OTP grant window for destructive marbete operations.
--
-- When an admin verifies a fresh single-use 6-digit OTP against
-- quorum-otp for a grant-eligible scope (today: `marbete.create`,
-- `marbete.update`, `marbete.delete`, `marbete.bulk_create`), the
-- BackOffice writes a row here that grants the actor a TTL window
-- (configurable via `OTP_GRANT_TTL_MINUTES`, default 20) during which
-- further destructive marbete operations proceed WITHOUT re-entering
-- an OTP. `marbete.reveal` is intentionally NOT grant-eligible: every
-- reveal still requires a per-operation OTP.
--
-- The grant is per-actor (session username) and per-scope. It is a
-- backoffice-local cache and does NOT change the quorum-otp provider
-- semantics — the OTP itself is still single-use upstream; the grant
-- simply lets the actor skip the per-op verify while the cache row
-- is still in the future.
--
-- Idempotency: safe to re-apply. CREATE TABLE/INDEX use IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS otp_grants (
  id         BIGSERIAL    PRIMARY KEY,
  actor      TEXT         NOT NULL,
  scope      TEXT         NOT NULL DEFAULT 'marbete',
  otp_id     TEXT         NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ  NOT NULL
);

-- Hot read path: findActive(actor, scope) → "an unexpired grant".
-- Composite index covers both the equality predicates (actor, scope)
-- and the range predicate (expires_at).
CREATE INDEX IF NOT EXISTS idx_otp_grants_actor_scope_expires
  ON otp_grants (actor, scope, expires_at);

COMMENT ON TABLE otp_grants IS
  'Per-actor / per-scope grant window issued after a successful single-use OTP verification. Lets destructive operations skip the per-op OTP verify while the row is still in the future. marbete.reveal is intentionally NOT grant-eligible and never writes here.';

COMMENT ON COLUMN otp_grants.otp_id IS
  'OTP id returned by the provider at the time the grant was issued; carried into audit_log.otp_id so rows written under a grant stay attributable to the original OTP.';

COMMIT;