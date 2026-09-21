-- 0003_dispositivos.sql
-- Authorized mobile/tablet devices (serial number required, brand/model optional).
-- Revocation is destructive in name only — we keep revoked_at + revoked_reason.

BEGIN;

CREATE TYPE dispositivo_status AS ENUM ('active', 'revoked');

CREATE TABLE dispositivos (
  id              BIGSERIAL    PRIMARY KEY,
  serial_number   TEXT         NOT NULL UNIQUE,
  brand           TEXT,
  model           TEXT,
  status          dispositivo_status NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by      TEXT         NOT NULL,
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT
);

CREATE INDEX idx_dispositivos_status       ON dispositivos(status);
CREATE INDEX idx_dispositivos_serial       ON dispositivos(serial_number);

COMMENT ON TABLE dispositivos IS
  'Authorized tablets/mobiles. Re-registration after revocation requires a different serial_number.';

COMMIT;
