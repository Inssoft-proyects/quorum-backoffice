/**
 * `POST /api/v1/mfa/get-subject` — end-to-end integration tests.
 *
 * Boots the real Fastify app via `buildApp`, signs HMAC requests with
 * `hmacSign` over the exact payload bytes (captureRawBodyPlugin
 * stashes `req.rawBody` before JSON parse), and exercises the full
 * HTTP envelope against the real PostgreSQL. Covers:
 *
 *   (a) transport-auth matrix — missing header / bad signature /
 *       stale ts / unknown service name → 401 deny.idp_untrusted
 *       (every transport failure collapses to one wire code).
 *       The empty-`BACKOFFICE_SERVICE_TOKENS` fail-closed case is
 *       covered by the shared `requireServiceAuth` suite in
 *       `access-decision.test.ts` (same preHandler).
 *   (b) deny matrix over seeded fixtures — deny.marbete_unknown
 *       (unknown AND revoked marbete, indistinguishable),
 *       deny.student_inactive, deny.device_unknown.
 *   (c) happy path — active marbete + active student + approved
 *       active device → 200 { canvas_user_id, matricula }.
 *   (d) body validation — short marbete_code → 400 validation_error.
 *   (e) leak guard — the response body never contains the raw
 *       marbete code or the raw serial on ANY path.
 */
import { Pool, types } from 'pg';
import path from 'node:path';
import { buildApp } from '../../src/app';
import { migrate } from '../../src/migrations';
import { hmacSign } from '../../src/lib/service-hmac';
import { hashMarbeteCode } from '../../src/lib/marbete-code';

const TEST_DATABASE_URL =
  process.env['DATABASE_URL_TEST'] ??
  'postgresql://websop:quorum_backoffice_dev@127.0.0.1:5432/quorum_backoffice_test';

types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

const SVC_NAME = 'canvas-portal';
const SVC_SECRET = 'integration-shared-secret-get-subject';
const SKEW = 60;

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  API_PORT: '3099',
  API_HOST: '127.0.0.1',
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
  OTP_SERVICE_URL: 'http://127.0.0.1:65535',
  OTP_SERVICE_TOKEN: 'test-otp-token-1234567890',
  OTP_SERVICE_NAME: 'quorum-backoffice',
  CANVAS_PORTAL_API_URL: 'http://127.0.0.1:65535',
  CANVAS_PORTAL_API_TOKEN: 'test-canvas-token-1234567890',
  SESSION_SECRET: 'a'.repeat(64),
  SESSION_TTL_SECONDS: '3600',
  AUTH_COOKIE_NAME: 'sid',
  AUTH_COOKIE_SECURE: 'false',
  AUTH_LOGIN_MAX_ATTEMPTS: '5',
  AUTH_LOGIN_WINDOW_SECONDS: '900',
  LOGIN_OTP_TTL_SECONDS: '300',
  LOGIN_OTP_MAX_ATTEMPTS: '5',
  LOGIN_OTP_REQUEST_WINDOW_SECONDS: '900',
  BACKOFFICE_SERVICE_TOKENS: `${SVC_NAME}:${SVC_SECRET}`,
  BACKOFFICE_SERVICE_HMAC_SKEW_SECONDS: String(SKEW),
};

const CODE_HAPPY = 'GETSUBJ-HAPPY-CODE-0001';
const CODE_UNKNOWN = 'GETSUBJ-UNKNOWN-CODE-9999';
const SERIAL_HAPPY = 'SN-GETSUBJ-HAPPY';
const SERIAL_OTHER = 'SN-GETSUBJ-OTHER';
const SERIAL_UNKNOWN = 'SN-GETSUBJ-MISSING';
const CANVAS_HAPPY = 91_001;
const CANVAS_OTHER = 91_002;
const CANVAS_INACTIVE = 91_003;
const MATRICULA_HAPPY = 'Z00042';

// ---------------------------------------------------------------------------
// Seed helpers (mirror mfa-authenticate.test.ts)
// ---------------------------------------------------------------------------

async function seedStudent(
  pool: Pool,
  canvasId: number,
  name: string,
  active: boolean,
  sisId: string | null = null,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO students_cache (canvas_user_id, full_name, email, sis_id, is_active)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [canvasId, name, `student-${canvasId}@quorum.local`, sisId, active],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('student_seed_failed');
  return id;
}

async function seedMarbete(
  pool: Pool,
  args: {
    code: string;
    status?: 'active' | 'inactive' | 'revoked';
    assignedStudentId?: number | null;
  },
): Promise<number> {
  const codeHash = hashMarbeteCode(args.code);
  // Derive a UNIQUE operator-facing id from the full code: the
  // public_uid column is UNIQUE, and a first-N-chars shortcut
  // collides whenever two seeded codes share a prefix.
  const publicUid = `m-${hashMarbeteCode(args.code).slice(0, 16).toUpperCase()}`;
  const r = await pool.query<{ id: number }>(
    `INSERT INTO marbetes
       (public_uid, code_hash, status, assigned_student_id, created_by, deleted_at, assigned_at)
     VALUES ($1, $2, $3::marbete_status, $4, 'tester', NULL,
             CASE WHEN $4::bigint IS NULL THEN NULL ELSE now() END)
     RETURNING id`,
    [publicUid, codeHash, args.status ?? 'active', args.assignedStudentId ?? null],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('marbete_seed_failed');
  return id;
}

async function seedDevice(
  pool: Pool,
  args: {
    serial: string;
    status?: 'active' | 'revoked';
    assignedStudentId?: number | null;
  },
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO dispositivos
       (serial_number, brand, model, status, created_by, assigned_student_id, revoked_at)
     VALUES ($1, 'TestBrand', 'TestModel', $2::dispositivo_status, 'tester', $3, $4)
     RETURNING id`,
    [
      args.serial,
      args.status ?? 'active',
      args.assignedStudentId ?? null,
      args.status === 'revoked' ? new Date() : null,
    ],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('device_seed_failed');
  return id;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('POST /api/v1/mfa/get-subject — S2S identity resolution (integration, real PG)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;

  async function inject(body: Record<string, unknown>): Promise<{
    statusCode: number;
    json: () => unknown;
    body: string;
  }> {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const sig = hmacSign(SVC_SECRET, ts, raw);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/get-subject',
      headers: {
        'content-type': 'application/json',
        authorization: `HMAC ${SVC_NAME} ${ts} ${sig}`,
      },
      payload: raw,
    });
    return { statusCode: res.statusCode, json: () => res.json(), body: res.body };
  }

  const happyBody = { marbete_code: CODE_HAPPY, serial_number: SERIAL_HAPPY };

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    await pool.query(`
      DROP TABLE IF EXISTS sessions CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
      DROP TABLE IF EXISTS audit_log_archive CASCADE;
      DROP TABLE IF EXISTS audit_log CASCADE;
      DROP TABLE IF EXISTS dispositivos CASCADE;
      DROP TABLE IF EXISTS marbetes CASCADE;
      DROP TABLE IF EXISTS students_cache CASCADE;
      DROP TYPE IF EXISTS user_role CASCADE;
      DROP TYPE IF EXISTS audit_action CASCADE;
      DROP TYPE IF EXISTS dispositivo_status CASCADE;
      DROP TYPE IF EXISTS marbete_status CASCADE;
      DROP TABLE IF EXISTS _migrations CASCADE;
    `);
    await migrate({ pool, dir: path.resolve(__dirname, '..', '..', 'migrations') });
    app = await buildApp({ config: TEST_ENV });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE audit_log RESTART IDENTITY`);
    await pool.query(`DELETE FROM sessions`);
    await pool.query(`DELETE FROM dispositivos`);
    await pool.query(`DELETE FROM marbetes`);
    await pool.query(`DELETE FROM students_cache`);

    const studentId = await seedStudent(
      pool,
      CANVAS_HAPPY,
      'Happy GetSubject Student',
      true,
      MATRICULA_HAPPY,
    );
    const otherStudentId = await seedStudent(pool, CANVAS_OTHER, 'Other GetSubject Student', true);
    await seedStudent(pool, CANVAS_INACTIVE, 'Inactive GetSubject Student', false);

    await seedMarbete(pool, { code: CODE_HAPPY, assignedStudentId: studentId });
    await seedDevice(pool, { serial: SERIAL_HAPPY, assignedStudentId: studentId });
    await seedDevice(pool, { serial: SERIAL_OTHER, assignedStudentId: otherStudentId });
  });

  // (a) transport-auth matrix -------------------------------------------------

  it('(a1) missing Authorization → 401 deny.idp_untrusted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/get-subject',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(happyBody),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  it('(a2) bad signature → 401 deny.idp_untrusted', async () => {
    const raw = JSON.stringify(happyBody);
    const ts = Math.floor(Date.now() / 1000);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/get-subject',
      headers: {
        'content-type': 'application/json',
        authorization: `HMAC ${SVC_NAME} ${ts} ${'0'.repeat(64)}`,
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  it('(a3) stale timestamp → 401 deny.idp_untrusted', async () => {
    const raw = JSON.stringify(happyBody);
    const ts = Math.floor(Date.now() / 1000) - (SKEW + 300);
    const sig = hmacSign(SVC_SECRET, ts, raw);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/get-subject',
      headers: {
        'content-type': 'application/json',
        authorization: `HMAC ${SVC_NAME} ${ts} ${sig}`,
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  it('(a4) unknown service name → 401 deny.idp_untrusted', async () => {
    const raw = JSON.stringify(happyBody);
    const ts = Math.floor(Date.now() / 1000);
    const sig = hmacSign(SVC_SECRET, ts, raw);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/get-subject',
      headers: {
        'content-type': 'application/json',
        authorization: `HMAC unknown-service ${ts} ${sig}`,
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  // (c) happy path ------------------------------------------------------------

  it('(c1) happy path → 200 { canvas_user_id, matricula }', async () => {
    const res = await inject(happyBody);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      canvas_user_id: CANVAS_HAPPY,
      matricula: MATRICULA_HAPPY,
    });
  });

  // (b) deny matrix -----------------------------------------------------------

  it('(b1) unknown marbete → 401 deny.marbete_unknown', async () => {
    const res = await inject({ marbete_code: CODE_UNKNOWN, serial_number: SERIAL_HAPPY });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'deny.marbete_unknown' });
  });

  it('(b2) revoked marbete → 401 deny.marbete_unknown (indistinguishable from unknown)', async () => {
    const studentId = await pool
      .query<{ id: number }>(`SELECT id FROM students_cache WHERE canvas_user_id = $1`, [
        CANVAS_HAPPY,
      ])
      .then((r) => r.rows[0]?.id as number);
    await seedMarbete(pool, {
      code: 'GETSUBJ-REVOKED-CODE-0002',
      status: 'revoked',
      assignedStudentId: studentId,
    });
    const res = await inject({
      marbete_code: 'GETSUBJ-REVOKED-CODE-0002',
      serial_number: SERIAL_HAPPY,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'deny.marbete_unknown' });
  });

  it('(b3) inactive student → 401 deny.student_inactive', async () => {
    const inactiveId = await pool
      .query<{ id: number }>(`SELECT id FROM students_cache WHERE canvas_user_id = $1`, [
        CANVAS_INACTIVE,
      ])
      .then((r) => r.rows[0]?.id as number);
    await seedMarbete(pool, {
      code: 'GETSUBJ-INACTIVE-STU-003',
      assignedStudentId: inactiveId,
    });
    await seedDevice(pool, {
      serial: 'SN-GETSUBJ-INACTIVE',
      assignedStudentId: inactiveId,
    });
    const res = await inject({
      marbete_code: 'GETSUBJ-INACTIVE-STU-003',
      serial_number: 'SN-GETSUBJ-INACTIVE',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'deny.student_inactive' });
  });

  it('(b4) device serial unknown → 401 deny.device_unknown', async () => {
    const res = await inject({ marbete_code: CODE_HAPPY, serial_number: SERIAL_UNKNOWN });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'deny.device_unknown' });
  });

  it('(b5) device bound to a different student → 200 (device is an allowlist, not an identity factor)', async () => {
    const res = await inject({ marbete_code: CODE_HAPPY, serial_number: SERIAL_OTHER });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      canvas_user_id: CANVAS_HAPPY,
      matricula: MATRICULA_HAPPY,
    });
  });

  // (d) validation ------------------------------------------------------------

  it('(d1) short marbete_code → 400 validation_error', async () => {
    const res = await inject({ marbete_code: 'short', serial_number: SERIAL_HAPPY });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation_error' });
  });

  it('(d2) missing serial_number → 400 validation_error', async () => {
    const res = await inject({ marbete_code: CODE_HAPPY });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation_error' });
  });

  // (e) leak guard ------------------------------------------------------------

  it('(e1) happy response never contains the raw marbete code or serial', async () => {
    const res = await inject(happyBody);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(CODE_HAPPY);
    expect(res.body).not.toContain(SERIAL_HAPPY);
  });

  it('(e2) deny response never contains the raw marbete code or serial', async () => {
    const res = await inject({ marbete_code: CODE_UNKNOWN, serial_number: SERIAL_UNKNOWN });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain(CODE_UNKNOWN);
    expect(res.body).not.toContain(SERIAL_UNKNOWN);
  });
});
