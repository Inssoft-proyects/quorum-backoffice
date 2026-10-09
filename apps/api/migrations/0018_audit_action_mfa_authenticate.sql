-- 0018_audit_action_mfa_authenticate.sql
-- M1 / Audit action registry: add 'student.mfa_authenticate' to the
-- audit_action enum so the MFA endpoint can record a granular event
-- for every authentication attempt (allow OR deny) without losing
-- the existing audit taxonomy. The action is the canonical entry
-- point for "a student tried to authenticate via MFA"; the
-- allow/deny discriminator is folded into the after_jsonb
-- `outcome` field (see apps/api/src/services/mfa-authenticate-service.ts).
--
-- This migration MUST run BEFORE any INSERT with
-- action='student.mfa_authenticate' AND it cannot share a transaction
-- with other DDL (PostgreSQL restriction on ALTER TYPE ADD VALUE;
-- new enum labels are visible only after COMMIT). Keep this file to
-- the single statement, mirroring the 0008/0009/0010/0016 pattern.

BEGIN;

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'student.mfa_authenticate';

COMMIT;
