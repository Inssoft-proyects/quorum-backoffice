-- 0023_audit_action_auth_verify_service.sql
-- S2S identity verification for Quorum QR adds a granular audit action.
-- The action is written by POST /api/v1/internal/auth/verify-otp and
-- records the calling service in entity_id.
--
-- This migration MUST run before any INSERT with
-- action='auth.verify_service' and cannot share a transaction with
-- other DDL (PostgreSQL ALTER TYPE ADD VALUE restriction).

BEGIN;

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'auth.verify_service';

COMMIT;
