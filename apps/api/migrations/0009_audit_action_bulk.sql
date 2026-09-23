-- 0009_audit_action_bulk.sql
-- Polish WU v4 / WU #3: bulk-upload endpoint for marbetes emits a single
-- aggregate audit entry per request with action='marbete.bulk_create'.
-- The after_jsonb column folds the metadata (count, source, fileName,
-- generated publicUids) so reads via `marbete.bulk_create` action filter
-- can reconstruct the operation without join gymnastics.
--
-- Standalone ALTER TYPE inside its own transaction (PG requires the enum
-- label to be committed before it can be referenced). The migration runner
-- already wraps each file in BEGIN/COMMIT.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'marbete.bulk_create';
