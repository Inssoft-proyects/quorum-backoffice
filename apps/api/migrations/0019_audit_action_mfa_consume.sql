-- 0019_audit_action_mfa_consume.sql
-- M3 / Audit action registry: add 'student.mfa_consume' to the
-- audit_action enum so the consume endpoint can record a granular
-- event for every successful MFA-token consumption. The action
-- captures the S2S call from Canvas to /api/v1/mfa/consume; the
-- allow/deny discriminator is folded into the after_jsonb
-- `outcome` field (ok | mfa_token_invalid).
--
-- This migration MUST run BEFORE any INSERT with
-- action='student.mfa_consume' AND it cannot share a transaction
-- with other DDL (PostgreSQL restriction on ALTER TYPE ADD VALUE;
-- new enum labels are visible only after COMMIT). Keep this file to
-- the single statement, mirroring the 0008/0009/0010/0016/0018
-- pattern.

BEGIN;

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'student.mfa_consume';

COMMIT;
