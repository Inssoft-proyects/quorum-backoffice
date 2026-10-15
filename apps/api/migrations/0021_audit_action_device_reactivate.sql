-- 0021_audit_action_device_reactivate.sql
-- Logical-delete model: add 'dispositivo.reactivate' to the audit_action
-- enum so the reactivation endpoint (and the create-upsert that re-registers
-- a revoked serial) can record an accurate audit row.
--
-- This migration MUST run BEFORE any INSERT with action =
-- 'dispositivo.reactivate' AND it cannot share a transaction with other DDL
-- (PostgreSQL restriction on ALTER TYPE ADD VALUE; new enum labels are visible
-- only after COMMIT). Keep this file to a single statement, mirroring 0008.

BEGIN;

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'dispositivo.reactivate';

COMMIT;
