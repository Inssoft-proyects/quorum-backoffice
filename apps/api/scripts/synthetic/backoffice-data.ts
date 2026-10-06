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
 *      Safety contract: ON CONFLICT (canvas_user_id) DO NOTHING.
 *      The script NEVER modifies a pre-existing students_cache
 *      row — if a row with the same canvas_user_id already
 *      exists (e.g. a real operator-created student, an E2E
 *      fixture, or any other pre-existing data), the entry is
 *      recorded as SKIPPED in the summary and the existing row
 *      is left completely untouched (no sis_id / full_name /
 *      email / is_active rewrite). The 7-row collision set
 *      reported by the parent against the production DB
 *      (canvas_user_id 1001, 1002, 1003, 9001, 90001, 90002,
 *      90003) is handled this way. A 23505 on the OTHER unique
 *      constraint (`uq_students_sis_id`) is also a skip with a
 *      distinct reason so the operator can pick a different
 *      seed if they want that entry to land.
 *
 *   2. Exactly 10 `marbetes`, one per the first 10
 *      SUCCESSFULLY-INSERTED students (i.e. skips are skipped
 *      here too) in deterministic order, with `code` = the
 *      secrets VALIDO-2609982468..077 hashed via sha256 (the
 *      same hashing helper used by the marbetes service). The
 *      plaintext "publicMessage" / "secretMessage" values are
 *      NEVER stored in the database; only the sha256 hash lands
 *      in `code_hash`. The first code (`VALIDO-2609982468`) is
 *      echoed ONCE in the final summary so the operator can run
 *      the MFA smoke test without re-reading the source; the
 *      other 9 codes are NEVER logged, NEVER stored, and NEVER
 *      printed in any form. Status `active`, `assigned_student_id`
 *      = the matching student's `students_cache.id`,
 *      `assigned_at` = now, `created_by` = `synthetic-seed`.
 *      The partial unique index `uq_marbete_active_per_student`
 *      (one active marbete per student) is respected by
 *      upserting on `public_uid`; if a target student already
 *      has an active marbete under a different `public_uid`,
 *      the conflicting row is reported as a per-row failure and
 *      the script continues. INVARIANT: every publicUid this
 *      seeder writes is `m-<first 6 hex chars of sha256(code)>`
 *      — a format disjoint from the operator UI's `CRD-####`
 *      format — so the ON CONFLICT DO UPDATE can only ever
 *      touch rows this seeder (or a prior run of it) created;
 *      no foreign row can be clobbered.
 *
 *   3. SYNTHETIC_DEVICE_COUNT devices in `dispositivos` with
 *      `serial_number` = 16-char lowercase hex (deterministic
 *      from the seed, unique), `brand` / `model` = NULL,
 *      `created_by` = `synthetic-seed`. The FIRST device serial
 *      is the literal `f401e1afcfd09b16` constant used by the
 *      MFA smoke test.
 *
 *   4. Device-student assignments per the 0015 schema: assign
 *      device i -> insertedStudent i (1:1 across
 *      min(devices, insertedStudents)). CRITICAL invariant:
 *      device `f401e1afcfd09b16` and marbete `VALIDO-2609982468`
 *      are both paired with the i-th SUCCESSFULLY-inserted
 *      student, so the MFA triple (marbete+device+student)
 *      validates end-to-end even when student skips land at
 *      the start of the mapping (e.g. the 1001-1003 collision
 *      set). The assignment UPDATE is UNCONDITIONAL for the
 *      paired rows and will CLOBBER any pre-existing manual
 *      re-assignment of a synthetic device to a different
 *      student; this is the intended synthetic-fixture
 *      behavior (the device must point at the fixture student
 *      for the MFA triple to hold).
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

interface StudentSkip {
  /** Index of this entry in the original mapping.entries[]. */
  index: number;
  sisId: string;
  canvasUserId: number;
  /**
   * Human-readable reason. Always starts with the literal
   * "pre-existing" so an operator can grep the summary for
   * every row this seeder did NOT own.
   */
  reason: string;
}

interface StudentUpsertResult {
  /** Rows this run actually inserted (or re-asserted on a clean re-run). */
  inserted: StudentRow[];
  /** Rows the seeder refused to touch because a pre-existing row already owned the canvas_user_id. */
  skipped: StudentSkip[];
}

/**
 * Insert synthetic students_cache rows WITHOUT clobbering any
 * pre-existing data.
 *
 * Critical safety contract: this function MUST NOT modify a row
 * that already exists in `students_cache`. Pre-existing rows
 * (e.g. operator-created fixtures, E2E test data, or rows from
 * a prior run of this seeder that the operator wants to keep)
 * carry real PII (name, email) and a real enrollment state; a
 * DO UPDATE here would silently null out the PII and re-assert
 * is_active=TRUE, which is data loss the operator cannot undo.
 *
 * Implementation: `ON CONFLICT (canvas_user_id) DO NOTHING`.
 * If the INSERT returns no row, a row with that canvas_user_id
 * already exists; we record the entry as SKIPPED and move on.
 * A 23505 on the OTHER unique constraint (`uq_students_sis_id`
 * — partial WHERE sis_id IS NOT NULL) is treated the same way
 * (the seeder never clobbers a pre-existing row) but surfaces
 * a distinct reason so the operator can investigate.
 *
 * Any other error (connection, syntax, permission) is fatal
 * because the script cannot tell whether partial progress is
 * safe to keep.
 */
async function upsertStudents(
  pool: Pool,
  entries: { sisId: string; canvasUserId: number }[],
): Promise<StudentUpsertResult> {
  const inserted: StudentRow[] = [];
  const skipped: StudentSkip[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i] as { sisId: string; canvasUserId: number };
    try {
      const r = await pool.query<{ id: string; canvas_user_id: string; sis_id: string }>(
        // ON CONFLICT (canvas_user_id) DO NOTHING: never modify
        // a pre-existing students_cache row. The RETURNING clause
        // only yields a row when the INSERT actually inserted
        // (not when the DO NOTHING path was taken), so an empty
        // result is the signal that a pre-existing row owns the
        // canvas_user_id and we must skip this entry.
        `INSERT INTO students_cache (canvas_user_id, sis_id, full_name, email, is_active)
         VALUES ($1, $2, NULL, NULL, TRUE)
         ON CONFLICT (canvas_user_id) DO NOTHING
         RETURNING id, canvas_user_id, sis_id`,
        [e.canvasUserId, e.sisId],
      );
      const row = r.rows[0];
      if (row) {
        inserted.push({
          id: Number(row.id),
          canvasUserId: Number(row.canvas_user_id),
          sisId: row.sis_id,
        });
        continue;
      }
      // Empty result: ON CONFLICT (canvas_user_id) was taken,
      // so a pre-existing row owns this canvas_user_id. We do
      // NOT select it (the SELECT would be a no-op for the
      // operator and we deliberately avoid reading PII we
      // already know is there).
      skipped.push({
        index: i,
        sisId: e.sisId,
        canvasUserId: e.canvasUserId,
        reason:
          'pre-existing students_cache row with this canvas_user_id; not modified',
      });
    } catch (err) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === '23505' && pgErr.constraint === 'uq_students_sis_id') {
        // The synthetic sis_id for this entry collides with a
        // pre-existing row's sis_id (different canvas_user_id).
        // Per the safety contract we still refuse to clobber,
        // and we report a distinct reason so the operator can
        // pick a different seed if they want this row to land.
        skipped.push({
          index: i,
          sisId: e.sisId,
          canvasUserId: e.canvasUserId,
          reason:
            `pre-existing students_cache row owns sis_id=${e.sisId} (constraint=uq_students_sis_id); ` +
            `not modified \u2014 pick a different SYNTHETIC_SEED to avoid the collision`,
        });
        continue;
      }
      // Unknown error: do not swallow. The operator must see
      // the raw pg error so they can decide whether to retry.
      throw err;
    }
  }
  return { inserted, skipped };
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
    // INVARIANT — safety contract for the marbete table.
    //
    // Every publicUid this seeder writes is of the form
    //   m-<first 6 hex chars of sha256(code)>
    // (lowercase hex only, prefixed with the literal `m-`).
    // Pre-existing marbetes in the production database (created
    // by the operator UI or the bulk-create endpoint) use the
    // `CRD-####` format. The two formats are disjoint, so
    // `ON CONFLICT (public_uid) DO UPDATE` below can only ever
    // touch rows this seeder (or a prior run of it) created —
    // a foreign row can never be matched, and therefore can
    // never be clobbered by the UPDATE branch.
    //
    // Re-runs of this same script against the same database DO
    // re-write the same `m-...` rows (the UPDATE branch fires),
    // but the values being written are byte-identical to what
    // was already there: the deterministic sha256(code_hash)
    // and the same assigned_student_id (because the student
    // upsert is now DO NOTHING — see upsertStudents), so the
    // re-write is observably a no-op.
    //
    // The partial unique index on
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

/**
 * Pair device i with the i-th SUCCESSFULLY-inserted student
 * across min(devices, insertedStudents). Devices beyond the
 * inserted-student list are reported as assignment skips
 * (NOT failures — the device is still created, it just has no
 * synthetic owner to bind to).
 *
 * Pairing invariant: device[0] (the MFA fixture serial
 * `f401e1afcfd09b16`) is paired with the first inserted
 * student, and that same inserted student also receives
 * marbete[0] (`VALIDO-2609982468`) from upsertMarbetes. The
 * two loops index by the same `inserted` list, so the MFA
 * triple holds regardless of where student skips land in the
 * mapping (including the 1001-1003 collision set reported by
 * the parent against the production DB).
 */
interface AssignmentResult {
  count: number;
  skips: { deviceSerial: string; reason: string }[];
}

async function assignDevicesToStudents(
  pool: Pool,
  devices: DispositivoRow[],
  insertedStudents: StudentRow[],
): Promise<AssignmentResult> {
  const pairs = Math.min(devices.length, insertedStudents.length);
  const skips: { deviceSerial: string; reason: string }[] = [];
  for (let i = 0; i < pairs; i += 1) {
    const device = devices[i] as DispositivoRow;
    const student = insertedStudents[i] as StudentRow;
    await pool.query(
      `UPDATE dispositivos
          SET assigned_student_id = $2
        WHERE id = $1
          AND status = 'active'`,
      [device.id, student.id],
    );
  }
  // Devices beyond the inserted-student list are left
  // unassigned (the column stays NULL) and surfaced as
  // skip entries so the operator can decide whether to
  // extend the synthetic student set or accept the shorter
  // device list. We do NOT fail the run for them.
  for (let i = pairs; i < devices.length; i += 1) {
    const device = devices[i] as DispositivoRow;
    skips.push({
      deviceSerial: device.serialNumber,
      reason:
        `no synthetic student to pair with at index ${i} (only ${pairs} students were inserted, ` +
        `the rest were skipped as pre-existing)`,
    });
  }
  return { count: pairs, skips };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Summary {
  /**
   * Count of students_cache rows THIS RUN inserted. Pre-existing
   * rows are never modified and never counted here; they live
   * in `studentsSkipped` / `studentSkips` instead.
   */
  students: number;
  /**
   * Count of mapping entries that collided with a pre-existing
   * students_cache row. These rows were NOT modified.
   */
  studentsSkipped: number;
  studentSkips: { index: number; sisId: string; canvasUserId: number; reason: string }[];
  marbetes: number;
  marbetesFailed: number;
  marbeteFailures: { index: number; studentId: number; publicUid: string; reason: string }[];
  devices: number;
  /**
   * Count of device<->student assignments this run actually
   * wrote. Always <= min(devices.length, inserted.length) and
   * always exactly matches the count of i where the i-th
   * SUCCESSFULLY-inserted student existed.
   */
  assignments: number;
  /**
   * Devices that could not be assigned because the mapping
   * had fewer inserted students than devices. Reported, not
   * failed.
   */
  assignmentSkips: { deviceSerial: string; reason: string }[];
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
    const studentResult = await upsertStudents(pool, mapping.entries);
    // The marbete + device loops both index by `studentResult.inserted`
    // (the i-th SUCCESSFULLY-inserted student). Skipped entries are
    // never paired, so the MFA triple (marbete[0] + device[0] +
    // inserted[0]) is robust to where the skips land in the mapping
    // — including the 1001-1003 collision set the parent reported
    // against the production DB.
    const insertedStudents = studentResult.inserted;
    const marbeteResult = await upsertMarbetes(pool, insertedStudents);
    const devices = await upsertDevices(pool, serials);
    const assignmentResult = await assignDevicesToStudents(pool, devices, insertedStudents);

    if (studentResult.skipped.length > 0) {
      // Per-entry skips are NEVER fatal: pre-existing rows are
      // left untouched. The summary below surfaces them so the
      // operator can audit which canvas_user_ids the seeder did
      // not own.
      logger.warn(
        { skips: studentResult.skipped },
        'synthetic_backoffice_student_skips',
      );
    }

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

    if (assignmentResult.skips.length > 0) {
      logger.warn(
        { skips: assignmentResult.skips },
        'synthetic_backoffice_assignment_skips',
      );
    }

    // The MFA triple is only meaningful when BOTH the first
    // marbete and the first inserted student exist. When either
    // is missing, we return `mfaTriple: null` so the operator
    // sees a null rather than a fake triple that would not
    // validate at the verifier.
    const mfaStudent = insertedStudents[0] ?? null;
    const mfaMarbete = marbeteResult.rows[0] ?? null;
    const mfaDevice = devices[0] as DispositivoRow;
    const mfaTriple: Summary['mfaTriple'] =
      mfaStudent && mfaMarbete
        ? {
            marbeteCode: MARBETE_PUBLIC_MESSAGES[0] as string,
            marbetePublicUid: mfaMarbete.publicUid,
            serial: mfaDevice.serialNumber,
            sisId: mfaStudent.sisId,
            canvasUserId: mfaStudent.canvasUserId,
          }
        : null;

    const summary: Summary = {
      students: insertedStudents.length,
      studentsSkipped: studentResult.skipped.length,
      studentSkips: studentResult.skipped,
      marbetes: marbeteResult.rows.length,
      marbetesFailed: marbeteResult.failures.length,
      marbeteFailures: marbeteResult.failures,
      devices: devices.length,
      assignments: assignmentResult.count,
      assignmentSkips: assignmentResult.skips,
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
