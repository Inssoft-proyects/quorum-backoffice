#!/usr/bin/env tsx
/**
 * Script B — Backoffice synthetic data seeder.
 *
 * Loads the synthetic students / marbetes / devices produced by
 * Script A (canvas-students.ts) and a local device generator into
 * the backoffice Postgres. Idempotent: every row is keyed on a
 * natural unique identifier (sis_id, code_hash, serial_number) and
 * is created with a check-then-insert or ON CONFLICT pattern, so
 * re-running the script is safe.
 *
 * Environment variables (env-only, NEVER hardcoded):
 *
 *   DATABASE_URL  (REQUIRED, no default)
 *       PostgreSQL connection string. This script is decoupled
 *       from the API's `loadConfig` so the operator does not
 *       need to set REDIS_URL, OTP_*, CANVAS_PORTAL_*, or
 *       SESSION_SECRET just to seed the backoffice. Only
 *       DATABASE_URL is required; all other knobs are read
 *       directly from env or have a hard-coded default.
 *
 *   SYNTHETIC_OUTPUT  (default
 *       apps/api/scripts/synthetic/out/students-mapping.json)
 *       JSON file written by Script A. The script reads the
 *       `entries: [{sisId, canvasUserId}, ...]` array and inserts
 *       one students_cache row per entry.
 *
 *   SYNTHETIC_SEED  (default quorum-synthetic-v1)
 *       Seed for the device-serial generator. The student
 *       matriculas come from the mapping file (so they are the
 *       same Canvas-side identifiers), but the device serials
 *       and the marbete→student assignment ordering are derived
 *       from the seed.
 *
 *   SYNTHETIC_DEVICE_COUNT  (default 1000, must be >= 1000)
 *       Number of synthetic devices to create.
 *
 * What it inserts (all idempotent, safe to re-run):
 *
 *   1. `students_cache`: one row per mapping entry. Fields:
 *        - canvas_user_id  (NOT NULL UNIQUE)
 *        - sis_id          (NOT NULL, UNIQUE partial)
 *        - full_name / email  = NULL  (PII-free by design)
 *        - is_active       = TRUE
 *      Idempotency: ON CONFLICT (canvas_user_id) DO UPDATE so a
 *      re-run re-asserts the canonical sis_id / NULL PII shape.
 *
 *   2. Exactly 10 `marbetes`, one per the first 10 mapping entries
 *      in deterministic order, with `code` = the secrets
 *      VALIDO-2609982468..077 hashed via sha256 (the same hashing
 *      helper used by the marbetes service). The plaintext
 *      "publicMessage" / "secretMessage" values are NEVER stored
 *      in the database; only the sha256 hash lands in `code_hash`.
 *      The first code (`VALIDO-2609982468`) is echoed ONCE in the
 *      final summary so the operator can run the MFA smoke test
 *      without re-reading the source; the other 9 codes are
 *      NEVER logged, NEVER stored, and NEVER printed in any
 *      form. Status `active`, `assigned_student_id` = the
 *      matching student's `students_cache.id`, `assigned_at` =
 *      now, `created_by` = `synthetic-seed`. The partial unique
 *      index `uq_marbete_active_per_student` (one active marbete
 *      per student) is respected by upserting on `public_uid`;
 *      if a target student already has an active marbete under
 *      a different `public_uid`, the conflicting row is reported
 *      as a per-row failure and the script continues.
 *
 *   3. SYNTHETIC_DEVICE_COUNT devices in `dispositivos` with
 *      `serial_number` = 16-char lowercase hex (deterministic
 *      from the seed, unique), `brand` / `model` = NULL,
 *      `created_by` = `synthetic-seed`. The FIRST device serial
 *      is the literal `f401e1afcfd09b16` constant used by the
 *      MFA smoke test.
 *
 *   4. Device-student assignments per the 0015 schema: assign
 *      device i -> student i (1:1 across min(devices, students)).
 *      CRITICAL invariant: device `f401e1afcfd09b16` and marbete
 *      `VALIDO-2609982468` are both assigned to the same student
 *      — the first mapping entry — so the MFA triple
 *      (marbete+device+student) validates end-to-end. The
 *      assignment UPDATE is UNCONDITIONAL and will CLOBBER any
 *      pre-existing manual re-assignment of a synthetic device
 *      to a different student; this is the intended synthetic-
 *      fixture behavior (the device must point at the fixture
 *      student for the MFA triple to hold).
 *
 * The script prints a final summary with counts and the MFA triple
 * (marbete code, serial, sis_id, canvas_user_id) so the operator
 * can run the MFA smoke test.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import pino from 'pino';
import { generateDeviceSerials } from './lib/generate';

// ---------------------------------------------------------------------------
// Marbete secrets (10 codes for the MFA smoke + smoke fixtures)
// ---------------------------------------------------------------------------

/**
 * The marbete codes. Each entry is the marbete "public message"
 * (the operator-facing code, e.g. what an operator types into
 * the marbete-create form). For the synthetic fixture the
 * public message IS the secret: there is no separate secret OTP
 * because the synthetic badge is a single-tier fixture.
 *
 * Storage:
 *   - Only `sha256(code)` lands in the `marbetes.code_hash`
 *     column. The plain text is NEVER written to the database.
 *
 * Logging:
 *   - `MARBETE_PUBLIC_MESSAGES[0]` (i.e. `VALIDO-2609982468`) is
 *     echoed ONCE in the final summary so the operator can run
 *     the MFA smoke test without re-reading the source. The
 *     other 9 codes are NEVER logged, NEVER stored, and NEVER
 *     printed in any form.
 *
 * (See the existing bulk-create endpoint and the marbete service
 * for the canonical "hash on the way in" flow.)
 */
const MARBETE_PUBLIC_MESSAGES: readonly string[] = [
  'VALIDO-2609982468',
  'VALIDO-2609982469',
  'VALIDO-2609982470',
  'VALIDO-2609982471',
  'VALIDO-2609982472',
  'VALIDO-2609982473',
  'VALIDO-2609982474',
  'VALIDO-2609982475',
  'VALIDO-2609982476',
  'VALIDO-2609982477',
];

const SYNTHETIC_ACTOR = 'synthetic-seed';

/**
 * Minimal pino logger for the synthetic seeder. We deliberately
 * do NOT reuse `createLogger()` from apps/api/src/lib/logger.ts
 * because that helper takes a full `Config` and the API config
 * also requires REDIS_URL / OTP_* / CANVAS_PORTAL_* / SESSION_SECRET
 * — none of which this script needs. A standalone pino with a
 * small redact list (mirroring the production logger's
 * `*.password` / `*.token` paths) gives us the same operational
 * guarantees without the env coupling.
 */
function createSyntheticLogger(): pino.Logger {
  return pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    redact: {
      paths: [
        '*.password',
        '*.passwordHash',
        '*.token',
        '*.otp',
        '*.otpCode',
        '*.serial_number',
      ],
      censor: '[REDACTED]',
    },
    base: { service: 'quorum-backoffice-synthetic-seed', env: 'seed' },
  });
}

// ---------------------------------------------------------------------------
// Config + mapping
// ---------------------------------------------------------------------------

interface ScriptConfig {
  databaseUrl: string;
  seed: string;
  deviceCount: number;
  mappingPath: string;
}

interface MappingFile {
  generatedAt?: string;
  seed?: string;
  count?: number;
  entries: { sisId: string; canvasUserId: number }[];
}

function loadScriptConfig(): ScriptConfig {
  // Minimal loader: ONLY DATABASE_URL is required. We deliberately
  // do NOT reuse `loadConfig()` from apps/api/src/config.ts because
  // the API config also requires REDIS_URL, OTP_SERVICE_*,
  // CANVAS_PORTAL_*, and SESSION_SECRET — none of which this
  // script uses. Forcing the operator to set those would be a
  // soft coupling that breaks whenever the API config grows.
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required (env-only). This script does not load the ' +
        'full API config, so REDIS_URL / OTP_SERVICE_* / CANVAS_PORTAL_* / ' +
        'SESSION_SECRET do not need to be set.',
    );
  }
  const seed = process.env['SYNTHETIC_SEED'] ?? 'quorum-synthetic-v1';
  const deviceCountRaw = process.env['SYNTHETIC_DEVICE_COUNT'] ?? '1000';
  const deviceCount = Number.parseInt(deviceCountRaw, 10);
  if (!Number.isInteger(deviceCount) || deviceCount < 1000) {
    throw new Error(
      `SYNTHETIC_DEVICE_COUNT must be an integer >= 1000 (got ${JSON.stringify(deviceCountRaw)})`,
    );
  }
  const defaultMapping = resolve(__dirname, 'out', 'students-mapping.json');
  const mappingPath = isAbsolute(process.env['SYNTHETIC_OUTPUT'] ?? '')
    ? (process.env['SYNTHETIC_OUTPUT'] as string)
    : resolve(process.env['SYNTHETIC_OUTPUT'] ?? defaultMapping);
  return { databaseUrl, seed, deviceCount, mappingPath };
}

async function loadMapping(path: string): Promise<MappingFile> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { entries?: unknown }).entries)) {
    throw new Error(`mapping file at ${path} is malformed (missing entries[])`);
  }
  const entries: { sisId: string; canvasUserId: number }[] = [];
  for (const e of (parsed as { entries: unknown[] }).entries) {
    if (!e || typeof e !== 'object') continue;
    const obj = e as { sisId?: unknown; canvasUserId?: unknown };
    if (typeof obj.sisId !== 'string' || obj.sisId.length === 0) continue;
    if (typeof obj.canvasUserId !== 'number' || !Number.isInteger(obj.canvasUserId)) continue;
    entries.push({ sisId: obj.sisId, canvasUserId: obj.canvasUserId });
  }
  if (entries.length === 0) {
    throw new Error(`mapping file at ${path} contains no usable entries`);
  }
  return parsed as MappingFile;
}

// ---------------------------------------------------------------------------
// Hashing helper (matches apps/api/src/lib/marbete-id.ts)
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Inserts (idempotent)
// ---------------------------------------------------------------------------

interface StudentRow {
  id: number;
  canvasUserId: number;
  sisId: string;
}

async function upsertStudents(
  pool: Pool,
  entries: { sisId: string; canvasUserId: number }[],
): Promise<StudentRow[]> {
  const out: StudentRow[] = [];
  for (const e of entries) {
    const r = await pool.query<{ id: string; canvas_user_id: string; sis_id: string }>(
      // ON CONFLICT (canvas_user_id) — re-assert NULL PII and the
      // canonical sis_id on every run.
      `INSERT INTO students_cache (canvas_user_id, sis_id, full_name, email, is_active)
       VALUES ($1, $2, NULL, NULL, TRUE)
       ON CONFLICT (canvas_user_id) DO UPDATE
         SET sis_id = EXCLUDED.sis_id,
             full_name = NULL,
             email = NULL,
             is_active = TRUE
       RETURNING id, canvas_user_id, sis_id`,
      [e.canvasUserId, e.sisId],
    );
    const row = r.rows[0];
    if (!row) throw new Error('students_cache upsert returned no row');
    out.push({
      id: Number(row.id),
      canvasUserId: Number(row.canvas_user_id),
      sisId: row.sis_id,
    });
  }
  return out;
}

interface MarbeteRow {
  id: number;
  publicUid: string;
  assignedStudentId: number;
}

interface MarbeteFailure {
  index: number;
  studentId: number;
  publicUid: string;
  reason: string;
}

interface MarbeteUpsertResult {
  rows: MarbeteRow[];
  failures: MarbeteFailure[];
}

/**
 * The partial unique index that enforces "one active marbete per
 * student" (see migration 0002_marbetes.sql). We detect this
 * constraint name in a 23505 to distinguish it from a different
 * uniqueness violation (e.g. a `public_uid` collision) and emit
 * a per-row failure rather than crashing the run.
 */
const UQ_MARBETE_ACTIVE_PER_STUDENT = 'uq_marbete_active_per_student';

async function upsertMarbetes(
  pool: Pool,
  students: StudentRow[],
): Promise<MarbeteUpsertResult> {
  const rows: MarbeteRow[] = [];
  const failures: MarbeteFailure[] = [];
  // Exactly 10 marbetes, one per the first 10 students in
  // deterministic order. Defensive: if the mapping has fewer
  // than 10 entries, we cap the loop to the available count.
  const count = Math.min(10, students.length, MARBETE_PUBLIC_MESSAGES.length);
  for (let i = 0; i < count; i += 1) {
    const code = MARBETE_PUBLIC_MESSAGES[i] as string;
    const codeHash = sha256Hex(code);
    const student = students[i] as StudentRow;
    // Use a 6-char marbete-id (operator-facing) derived from the
    // code hash so the same code always produces the same publicUid
    // and a re-run is a clean no-op. The 6 hex chars are taken
    // from the hash, prefixed with `m-` to match the service's
    // `m-XXXXXX` shape. 6 hex chars = 16^6 = ~16M possible ids,
    // which is more than enough to keep the 10 fixtures unique
    // even for unrelated code lists.
    const publicUid = `m-${codeHash.slice(0, 6)}`;
    // Idempotent: ON CONFLICT (public_uid) DO UPDATE re-asserts
    // the assignment. The partial unique index on
    // (assigned_student_id) WHERE status='active' AND deleted_at IS NULL
    // is respected when the same public_uid is re-applied to the
    // same student (we update the existing row in place). When a
    // target student already has an ACTIVE marbete under a
    // DIFFERENT public_uid, the partial unique index rejects the
    // INSERT and pg raises 23505 with constraint
    // `uq_marbete_active_per_student`; we trap that case below
    // and report it as a per-row failure so the rest of the
    // batch (and the rest of the script) can continue.
    try {
      const r = await pool.query<{
        id: string;
        public_uid: string;
        assigned_student_id: string;
      }>(
        `INSERT INTO marbetes (public_uid, code_hash, status, assigned_student_id, assigned_at, created_by)
         VALUES ($1, $2, 'active', $3, now(), $4)
         ON CONFLICT (public_uid) DO UPDATE
           SET code_hash = EXCLUDED.code_hash,
               status = 'active',
               assigned_student_id = EXCLUDED.assigned_student_id,
               assigned_at = now(),
               deleted_at = NULL
         RETURNING id, public_uid, assigned_student_id`,
        [publicUid, codeHash, student.id, SYNTHETIC_ACTOR],
      );
      const row = r.rows[0];
      if (!row) {
        failures.push({
          index: i,
          studentId: student.id,
          publicUid,
          reason: 'marbetes upsert returned no row (unexpected)',
        });
        continue;
      }
      rows.push({
        id: Number(row.id),
        publicUid: row.public_uid,
        assignedStudentId: Number(row.assigned_student_id),
      });
    } catch (err) {
      const e = err as { code?: string; constraint?: string; message?: string };
      if (e.code === '23505' && e.constraint === UQ_MARBETE_ACTIVE_PER_STUDENT) {
        failures.push({
          index: i,
          studentId: student.id,
          publicUid,
          reason:
            `student ${student.id} already has an active marbete under a ` +
            `different public_uid (constraint=${UQ_MARBETE_ACTIVE_PER_STUDENT}); ` +
            `soft-delete or revoke the conflicting marbete before re-running`,
        });
        continue;
      }
      // Any OTHER error (e.g. a different 23505 like a public_uid
      // collision, or a network / auth error) is fatal: we do
      // not know whether partial progress is safe to keep, and
      // the operator should see the raw error.
      throw err;
    }
  }
  return { rows, failures };
}

interface DispositivoRow {
  id: number;
  serialNumber: string;
}

async function upsertDevices(
  pool: Pool,
  serials: string[],
): Promise<DispositivoRow[]> {
  const out: DispositivoRow[] = [];
  for (const serial of serials) {
    const r = await pool.query<{ id: string; serial_number: string }>(
      // Idempotent: ON CONFLICT (serial_number) DO NOTHING keeps
      // the original row (and any existing assigned_student_id)
      // untouched. The script then runs a separate UPDATE below
      // to enforce the device->student assignment, which is a
      // no-op when the device is already correctly bound.
      `INSERT INTO dispositivos (serial_number, brand, model, created_by)
       VALUES ($1, NULL, NULL, $2)
       ON CONFLICT (serial_number) DO NOTHING
       RETURNING id, serial_number`,
      [serial, SYNTHETIC_ACTOR],
    );
    let row = r.rows[0];
    if (!row) {
      // The device already existed; fetch its id so we can assign it.
      const sel = await pool.query<{ id: string; serial_number: string }>(
        `SELECT id, serial_number FROM dispositivos WHERE serial_number = $1`,
        [serial],
      );
      const s = sel.rows[0];
      if (!s) throw new Error(`dispositivo upsert then select failed for ${serial}`);
      row = s;
    }
    out.push({ id: Number(row.id), serialNumber: row.serial_number });
  }
  return out;
}

async function assignDevicesToStudents(
  pool: Pool,
  devices: DispositivoRow[],
  students: StudentRow[],
): Promise<number> {
  // 1:1 assignment device i -> student i across min(devices, students).
  // CRITICAL: device[0] is the MFA fixture (f401e1afcfd09b16) and
  // student[0] is also the marbete fixture (VALIDO-2609982468)
  // because the marbete loop above also took students[0]. The MFA
  // triple therefore holds automatically.
  const pairs = Math.min(devices.length, students.length);
  for (let i = 0; i < pairs; i += 1) {
    const device = devices[i] as DispositivoRow;
    const student = students[i] as StudentRow;
    await pool.query(
      `UPDATE dispositivos
          SET assigned_student_id = $2
        WHERE id = $1
          AND status = 'active'`,
      [device.id, student.id],
    );
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Summary {
  students: number;
  marbetes: number;
  marbetesFailed: number;
  marbeteFailures: { index: number; studentId: number; publicUid: string; reason: string }[];
  devices: number;
  assignments: number;
  mfaTriple: {
    marbeteCode: string;
    marbetePublicUid: string | null;
    serial: string;
    sisId: string;
    canvasUserId: number;
  } | null;
}

async function run(): Promise<Summary> {
  const cfg = loadScriptConfig();
  const logger = createSyntheticLogger();
  logger.info(
    { databaseUrl: cfg.databaseUrl, seed: cfg.seed, deviceCount: cfg.deviceCount, mappingPath: cfg.mappingPath },
    'synthetic_backoffice_start',
  );

  const mapping = await loadMapping(cfg.mappingPath);
  if (mapping.entries.length < 1) {
    throw new Error('mapping file has zero entries; cannot seed backoffice');
  }
  if (mapping.entries.length < 10) {
    logger.warn(
      { entries: mapping.entries.length },
      'mapping file has fewer than 10 entries; the 10-marbeta fixture will be truncated',
    );
  }

  const serials = generateDeviceSerials({ seed: cfg.seed, count: cfg.deviceCount });

  const pool = new Pool({ connectionString: cfg.databaseUrl, max: 4 });
  try {
    const students = await upsertStudents(pool, mapping.entries);
    const marbeteResult = await upsertMarbetes(pool, students);
    const devices = await upsertDevices(pool, serials);
    const assignmentCount = await assignDevicesToStudents(pool, devices, students);

    if (marbeteResult.failures.length > 0) {
      // Per-row failures are NEVER fatal; the rest of the script
      // (devices, assignments) still ran, and the summary below
      // surfaces them so the operator can re-derive the script's
      // state without re-reading the code.
      logger.warn(
        { failures: marbeteResult.failures },
        'synthetic_backoffice_marbete_failures',
      );
    }

    // The MFA triple is only meaningful when the first marbete
    // (the one the smoke test exercises) actually landed. When it
    // was rejected, we return `mfaTriple: null` so the operator
    // sees the failure rather than a fake triple that would not
    // validate at the verifier.
    const mfaStudent = students[0] as StudentRow;
    const mfaMarbete = marbeteResult.rows[0] ?? null;
    const mfaDevice = devices[0] as DispositivoRow;
    const mfaTriple: Summary['mfaTriple'] = mfaMarbete
      ? {
          marbeteCode: MARBETE_PUBLIC_MESSAGES[0] as string,
          marbetePublicUid: mfaMarbete.publicUid,
          serial: mfaDevice.serialNumber,
          sisId: mfaStudent.sisId,
          canvasUserId: mfaStudent.canvasUserId,
        }
      : null;

    const summary: Summary = {
      students: students.length,
      marbetes: marbeteResult.rows.length,
      marbetesFailed: marbeteResult.failures.length,
      marbeteFailures: marbeteResult.failures,
      devices: devices.length,
      assignments: assignmentCount,
      mfaTriple,
    };

    logger.info(summary, 'synthetic_backoffice_done');
    // eslint-disable-next-line no-console
    console.log('synthetic_backoffice_summary', JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

// Only run when this file is executed directly. Without this
// guard the script's env validation fires at import time, which
// would crash a Jest harness (or any other importer) with
// `process.exit(1)` before it can do its work. Mirrors the
// entrypoint guard in canvas-students.ts. The apps/api package
// is CJS, so `require.main === module` is the right check.
const isEntrypoint = typeof require !== 'undefined' && require.main === module;

if (isEntrypoint) {
  run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('synthetic_backoffice_failed', err);
    process.exit(1);
  });
}
