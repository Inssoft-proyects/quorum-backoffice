-- 0014_sequence_repair.sql
-- Repair primary-key sequences left behind by explicit-id seeding.
--
-- Found by the e2e bulk-upload write flow (2026-10-02): seeded rows
-- (e.g. marbetes ids 1..10) were inserted with explicit ids without
-- advancing their SERIAL sequences, so the first DEFAULT-id INSERT hit
--   SQLSTATE 23505: Key (id)=(1) already exists (marbetes_pkey).
-- Single-row create() has the same exposure: its 23505 retry only
-- handles the public_uid constraint.
--
-- This migration realigns every public table's `id` sequence with the
-- current MAX(id): with rows present the next nextval() returns
-- MAX(id)+1; on an empty table it starts at 1. Idempotent and safe to
-- re-apply. Tables whose PK is not a serial/identity `id` column are
-- skipped (pg_get_serial_sequence returns NULL).

DO $$
DECLARE
  t text;
  seq text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'marbetes', 'students_cache', 'dispositivos',
    'audit_log', 'otp_grants', 'users', 'sessions'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = t
    ) THEN
      seq := pg_get_serial_sequence(t, 'id');
      IF seq IS NOT NULL THEN
        EXECUTE format(
          'SELECT setval(%L, GREATEST((SELECT COALESCE(MAX(id), 1) FROM %I), 1), EXISTS(SELECT 1 FROM %I))',
          seq, t, t
        );
      END IF;
    END IF;
  END LOOP;
END $$;
