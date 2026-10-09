-- 0016_audit_action_device_assignment.sql
-- B2a / Audit action registry: add 'dispositivo.assign' and
-- 'dispositivo.unassign' to the audit_action enum so the device
-- assignment endpoint can record granular events when an admin binds
-- a dispositivo to a Canvas student and when that binding is released.
--
-- This migration MUST run BEFORE any INSERT with action IN
-- ('dispositivo.assign','dispositivo.unassign') (the B2a service emits
-- these on every successful bind/unbind) AND it cannot share a
-- transaction with other DDL (PostgreSQL restriction on ALTER TYPE
-- ADD VALUE; new enum labels are visible only after COMMIT). Keep
-- this file to the two statements, mirroring the 0008 pattern.

BEGIN;

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'dispositivo.assign';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'dispositivo.unassign';

COMMIT;
