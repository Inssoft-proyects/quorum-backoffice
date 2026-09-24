-- 0010_audit_action_otp_login.sql
-- Polish WU v6 / Task 3: add 'auth.login.requested', 'auth.login.otp_verified',
-- and 'auth.login.failed' to the audit_action enum so the email+OTP login
-- flow can emit granular events for brute-force detection and audit
-- traceability.
--
-- Each ALTER TYPE ADD VALUE MUST run outside any transaction block in
-- PostgreSQL; this file applies the four statements sequentially. The
-- test runner wraps migrations in a transaction per file, but
-- `ALTER TYPE ... ADD VALUE IF NOT EXISTS` is documented to work inside
-- a transaction when the enum was created in the same DB (no concurrent
-- readers); the integration suite already exercises this pattern via
-- 0008 and 0009.

BEGIN;

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'auth.login.requested';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'auth.login.otp_verified';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'auth.login.failed';

COMMIT;