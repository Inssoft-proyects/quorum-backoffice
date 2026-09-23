-- 0008_audit_action_reveal.sql
-- Polish WU v3 / Task 4 follow-up: add 'marbete.reveal' to the audit_action
-- enum so the reveal endpoint can record an accurate audit row.
--
-- This migration MUST run BEFORE any INSERT with action='marbete.reveal'
-- (which happens in the integration test added with 0007 / WU #1) AND it
-- cannot share a transaction with other DDL (PostgreSQL restriction on
-- ALTER TYPE ADD VALUE). Keep this file to a single statement.

BEGIN;

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'marbete.reveal';

COMMIT;