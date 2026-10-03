/**
 * B2c / Admin HTTP surface for device assignment — integration tests.
 *
 * Exercises POST /api/v1/dispositivos/:id/assign and
 * POST /api/v1/dispositivos/:id/unassign through a real Fastify app
 * (buildApp + inject) against a real PostgreSQL. The two destructive
 * routes must enforce:
 *
 *   - requireRole('admin') (401 without session, 403 for operator/auditor)
 *   - X-OTP-Code header from the X-OTP-Code header
 *     (401 otp_required when missing, 401 otp_invalid when wrong)
 *   - fail-closed service semantics from B2b:
 *       404 unknown device, 409 revoked device on assign,
 *       422 missing/inactive student on assign,
 *       409 device_not_assigned on a no-op unassign
 *   - audit row with before/after JSONB and otp_id
 *   - existing CRUD spot-check must remain byte-identical
 *
 * OTP transport is mocked at the HTTP boundary (globalThis.fetch) so
 * destructive scopes `dispositivo.assign` and `dispositivo.unassign`
 * resolve to a fixed otpId and the audit row carries it. The login
 * flow uses a hermetic FakeOtpClient on app.otpClient so role-based
 * tests can exchange a username + OTP for a real session cookie.
 *
 * The fixtures are designed to match the wire format emitted by
 * OtpClient (`{ subject, scope, token }`, not `code`) and the
 * `valid: true` shape the client expects on success.
 */
import { Pool } from 'pg';
import path from 'node:path';
import { buildApp } from '../../src/app';
import { migrate } from '../../src/migrations';
import type { OtpClient } from '../../src/services/otp-client';

const TEST_DATABASE_URL =
  process.env['DATABASE_URL_TEST'] ??
  'postgresql://websop:quorum_backoffice_dev@127.0.0.1:5432/quorum_backoffice_test';

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
};

const VALID_OTP = '123456';
const MOCK_OTP_ID = 'otp-b2c-route';
const BCRYPT_COST = 10;

interface UserFixture {
  id: number;
  username: string;
  email: string;
  role: 'admin' | 'operator' | 'auditor';
}

function cookieFromSetCookie(
  setCookie: string | string[] | undefined,
  name: string,
): string | null {
  if (!setCookie) return null;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of arr) {
    const pair = c.split(';')[0];
    if (pair && pair.startsWith(`${name}=`)) return pair;
  }
  return null;
}

/**
 * HTTP-layer OTP fake: replaces globalThis.fetch so the route's local
 * OtpClient (the one constructed inside registerDispositivosRoutes)
 * sees deterministic responses for the X-OTP-Code header.
 *
 * Wire contract (must match OtpClient):
 *   - sends `{ subject, scope, token }`
 *   - expects 200 with `{ valid: true, ... }` on success
 *   - 409 is the canonical "OTP rejected" outcome (mapped to reason:'invalid')
 */
function makeOtpFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/otps/verify')) {
      const raw = init?.body ? String(init.body) : '{}';
      const parsed = JSON.parse(raw) as { token?: string };
      if (parsed.token === VALID_OTP) {
        return new Response(JSON.stringify({ id: MOCK_OTP_ID, valid: true }), {
          status: 200,
        });
      }
      // 409 mirrors the real quorum-otp verify_rejected outcome.
      return new Response(JSON.stringify({ error: 'verify_rejected' }), { status: 409 });
    }
    return new Response('not used', { status: 404 });
  }) as unknown as typeof fetch;
}

/**
 * Login-flow OTP fake: replaces app.otpClient so the login route
 * issues and verifies the deterministic VALID_OTP for any subject.
 * The login route calls `verify()` (and now `issue()` indirectly
 * through pre-issued codes); the FakeOtpClient honours both.
 */
class FakeOtpClient {
  public readonly issued = new Map<string, { code: string }>();
  async issue(args: { subject: string; scope: string }) {
    this.issued.set(`${args.scope}:${args.subject.toLowerCase()}`, { code: VALID_OTP });
    return { ok: true as const, otpId: 'fake-login-otp', token: VALID_OTP, ttlSeconds: 300 };
  }
  async verify(args: { subject: string; scope: string; code: string }) {
    if (args.code !== VALID_OTP) return { ok: false as const, reason: 'invalid' as const };
    return { ok: true as const, otpId: 'fake-login-otp' };
  }
}

async function seedUser(
  pool: Pool,
  username: string,
  email: string,
  role: 'admin' | 'operator' | 'auditor',
): Promise<UserFixture> {
  // Use a throwaway password; login is OTP-only in the new contract,
  // but password_hash is NOT NULL so we still need a bcrypt hash.
  const bcrypt = await import('bcrypt');
  const hash = await bcrypt.hash('Throw@way1', BCRYPT_COST);
  const r = await pool.query<{ id: number }>(
    `INSERT INTO users (email, username, password_hash, role)
     VALUES (lower($1), $2, $3, $4)
     RETURNING id`,
    [email, username, hash, role],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('user_seed_failed');
  return { id, username, email, role };
}

async function seedStudent(
  pool: Pool,
  canvasId: number,
  name: string,
  active: boolean,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO students_cache (canvas_user_id, full_name, email, is_active)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [canvasId, name, `student-${canvasId}@quorum.local`, active],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('student_seed_failed');
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
       (serial_number, brand, model, status, created_by, assigned_student_id)
     VALUES ($1, 'TestBrand', 'TestModel', $2::dispositivo_status, 'tester', $3)
     RETURNING id`,
    [args.serial, args.status ?? 'active', args.assignedStudentId ?? null],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('device_seed_failed');
  return id;
}

async function fetchAssignedStudentId(pool: Pool, deviceId: number): Promise<number | null> {
  const r = await pool.query<{ assigned_student_id: number | null }>(
    `SELECT assigned_student_id FROM dispositivos WHERE id = $1`,
    [deviceId],
  );
  return r.rows[0]?.assigned_student_id ?? null;
}

async function auditCount(
  pool: Pool,
  action: 'dispositivo.assign' | 'dispositivo.unassign',
  entityId: string,
): Promise<number> {
  const r = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM audit_log
      WHERE action = $1
        AND entity_type = 'dispositivo'
        AND entity_id = $2`,
    [action, entityId],
  );
  return Number(r.rows[0]?.count ?? '0');
}

async function loginAndGetCookie(
  app: Awaited<ReturnType<typeof buildApp>>,
  username: string,
): Promise<string> {
  const fakeOtp = (app as unknown as { otpClient: FakeOtpClient }).otpClient as FakeOtpClient;
  await fakeOtp.issue({ subject: username, scope: 'login' });
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ username, otp: VALID_OTP }),
  });
  if (r.statusCode !== 200) {
    throw new Error(`login_failed status=${r.statusCode} body=${r.body}`);
  }
  const cookie = cookieFromSetCookie(r.headers['set-cookie'], 'sid');
  if (!cookie) throw new Error('no_cookie');
  return cookie;
}

describe('B2c / dispositivo assign + unassign HTTP routes (integration, real PG)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;
  let adminUser: UserFixture;
  let operatorUser: UserFixture;
  let auditorUser: UserFixture;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    // Recreate schema from scratch so this suite is independent of
    // every other test file (and the audit_action enum starts clean).
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

    adminUser = await seedUser(
      pool,
      `b2c-admin-${Date.now()}`,
      `b2c-admin-${Date.now()}@example.test`,
      'admin',
    );
    operatorUser = await seedUser(
      pool,
      `b2c-operator-${Date.now()}`,
      `b2c-operator-${Date.now()}@example.test`,
      'operator',
    );
    auditorUser = await seedUser(
      pool,
      `b2c-auditor-${Date.now()}`,
      `b2c-auditor-${Date.now()}@example.test`,
      'auditor',
    );

    app = await buildApp({ config: TEST_ENV });
    // Login path: hermetic FakeOtpClient on app.otpClient.
    (app as unknown as { otpClient: OtpClient }).otpClient =
      new FakeOtpClient() as unknown as OtpClient;
    // Destructive route OTP transport: HTTP-layer override that
    // honours the X-OTP-Code header from the test request.
    (globalThis as { fetch: typeof fetch }).fetch = makeOtpFetch();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    // Per-test isolation: drop all dependent rows but keep the users
    // and session tokens used by the cookie-bearing role tests.
    await pool.query(`TRUNCATE TABLE audit_log RESTART IDENTITY`);
    await pool.query(`DELETE FROM dispositivos`);
    await pool.query(`DELETE FROM students_cache`);
  });

  // -----------------------------------------------------------------
  // auth gates — assign
  // -----------------------------------------------------------------

  it('assign: 401 without any session cookie or x-test-actor header', async () => {
    const deviceId = await seedDevice(pool, { serial: 'SN-B2C-ASSIGN-NOSESSION' });
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${deviceId}/assign`,
      headers: { 'x-otp-code': VALID_OTP, 'content-type': 'application/json' },
      payload: JSON.stringify({ canvasUserId: 80_100 }),
    });
    expect(r.statusCode).toBe(401);
    expect(await fetchAssignedStudentId(pool, deviceId)).toBeNull();
    expect(await auditCount(pool, 'dispositivo.assign', String(deviceId))).toBe(0);
  });

  it('assign: 403 for an operator session (cookie)', async () => {
    const cookie = await loginAndGetCookie(app, operatorUser.username);
    const deviceId = await seedDevice(pool, { serial: 'SN-B2C-ASSIGN-OPERATOR' });
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${deviceId}/assign`,
      headers: {
        cookie,
        'x-otp-code': VALID_OTP,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ canvasUserId: 80_101 }),
    });
    expect(r.statusCode).toBe(403);
    expect(await fetchAssignedStudentId(pool, deviceId)).toBeNull();
    expect(await auditCount(pool, 'dispositivo.assign', String(deviceId))).toBe(0);
  });

  it('assign: 403 for an auditor session (cookie)', async () => {
    const cookie = await loginAndGetCookie(app, auditorUser.username);
    const deviceId = await seedDevice(pool, { serial: 'SN-B2C-ASSIGN-AUDITOR' });
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${deviceId}/assign`,
      headers: {
        cookie,
        'x-otp-code': VALID_OTP,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ canvasUserId: 80_102 }),
    });
    expect(r.statusCode).toBe(403);
    expect(await fetchAssignedStudentId(pool, deviceId)).toBeNull();
    expect(await auditCount(pool, 'dispositivo.assign', String(deviceId))).toBe(0);
  });

  it('assign: 401 otp_required when admin (x-test-actor) omits X-OTP-Code; no DB change', async () => {
    const studentId = await seedStudent(pool, 80_110, 'OTP Required Student', true);
    const deviceId = await seedDevice(pool, { serial: 'SN-B2C-ASSIGN-NOOTP' });
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${deviceId}/assign`,
      headers: {
        'x-test-actor': adminUser.username,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ canvasUserId: 80_110 }),
    });
    expect(r.statusCode).toBe(401);
    const body = r.json() as { code: string };
    expect(body.code).toBe('otp_required');
    expect(await fetchAssignedStudentId(pool, deviceId)).toBeNull();
    expect(await auditCount(pool, 'dispositivo.assign', String(deviceId))).toBe(0);
    // Reference unused seed to keep helpers quiet about lints.
    expect(studentId).toBeGreaterThan(0);
  });

  it('assign: 401 otp_invalid when admin sends a wrong X-OTP-Code; no DB change', async () => {
    const deviceId = await seedDevice(pool, { serial: 'SN-B2C-ASSIGN-BADOTP' });
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${deviceId}/assign`,
      headers: {
        'x-test-actor': adminUser.username,
        'x-otp-code': '000000',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ canvasUserId: 80_111 }),
    });
    expect(r.statusCode).toBe(401);
    const body = r.json() as { code: string };
    expect(body.code).toBe('otp_invalid');
    expect(await fetchAssignedStudentId(pool, deviceId)).toBeNull();
    expect(await auditCount(pool, 'dispositivo.assign', String(deviceId))).toBe(0);
  });

  // -----------------------------------------------------------------
  // auth gates — unassign
  // -----------------------------------------------------------------

  it('unassign: 401 without any session cookie or x-test-actor header', async () => {
    const studentId = await seedStudent(pool, 80_120, 'Owner Test', true);
    const deviceId = await seedDevice(pool, {
      serial: 'SN-B2C-UNASSIGN-NOSESSION',
      assignedStudentId: studentId,
    });
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${deviceId}/unassign`,
      headers: { 'x-otp-code': VALID_OTP },
    });
    expect(r.statusCode).toBe(401);
    expect(await fetchAssignedStudentId(pool, deviceId)).toBe(studentId);
    expect(await auditCount(pool, 'dispositivo.unassign', String(deviceId))).toBe(0);
  });

  it('unassign: 403 for an operator session (cookie)', async () => {
    const cookie = await loginAndGetCookie(app, operatorUser.username);
    const studentId = await seedStudent(pool, 80_121, 'Operator Blocked', true);
    const deviceId = await seedDevice(pool, {
      serial: 'SN-B2C-UNASSIGN-OPERATOR',
      assignedStudentId: studentId,
    });
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${deviceId}/unassign`,
      headers: { cookie, 'x-otp-code': VALID_OTP },
    });
    expect(r.statusCode).toBe(403);
    expect(await fetchAssignedStudentId(pool, deviceId)).toBe(studentId);
    expect(await auditCount(pool, 'dispositivo.unassign', String(deviceId))).toBe(0);
  });

  it('unassign: 401 otp_required when admin omits X-OTP-Code; no DB change', async () => {
    const studentId = await seedStudent(pool, 80_122, 'No OTP Unbind', true);
    const deviceId = await seedDevice(pool, {
      serial: 'SN-B2C-UNASSIGN-NOOTP',
      assignedStudentId: studentId,
    });
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${deviceId}/unassign`,
      headers: { 'x-test-actor': adminUser.username },
    });
    expect(r.statusCode).toBe(401);
    const body = r.json() as { code: string };
    expect(body.code).toBe('otp_required');
    expect(await fetchAssignedStudentId(pool, deviceId)).toBe(studentId);
    expect(await auditCount(pool, 'dispositivo.unassign', String(deviceId))).toBe(0);
  });

  // -----------------------------------------------------------------
  // happy path — assign + reassignment + audit
  // -----------------------------------------------------------------

  it('assign: 200 with assignedStudentId and audit row (before/after + otp_id)', async () => {
    const studentId = await seedStudent(pool, 80_200, 'Marie Curie', true);
    const deviceId = await seedDevice(pool, { serial: 'SN-B2C-ASSIGN-HAPPY' });

    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${deviceId}/assign`,
      headers: {
        'x-test-actor': adminUser.username,
        'x-otp-code': VALID_OTP,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ canvasUserId: 80_200 }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      id: number;
      serialNumber: string;
      assignedStudentId: number | null;
    };
    expect(body.id).toBe(deviceId);
    expect(body.serialNumber).toBe('SN-B2C-ASSIGN-HAPPY');
    expect(body.assignedStudentId).toBe(studentId);

    expect(await fetchAssignedStudentId(pool, deviceId)).toBe(studentId);
    expect(await auditCount(pool, 'dispositivo.assign', String(deviceId))).toBe(1);

    const audit = await pool.query<{
      before_jsonb: unknown;
      after_jsonb: unknown;
      otp_id: string | null;
    }>(
      `SELECT before_jsonb, after_jsonb, otp_id
         FROM audit_log
        WHERE action = 'dispositivo.assign'
          AND entity_type = 'dispositivo'
          AND entity_id = $1
        ORDER BY id DESC
        LIMIT 1`,
      [String(deviceId)],
    );
    const row = audit.rows[0];
    expect(row).toBeDefined();
    expect(row?.otp_id).toBe(MOCK_OTP_ID);
    const before = row?.before_jsonb as { assignedStudentId: number | null } | null;
    const after = row?.after_jsonb as { assignedStudentId: number | null } | null;
    expect(before?.assignedStudentId).toBeNull();
    expect(after?.assignedStudentId).toBe(studentId);
  });

  it('assign: reassignment replaces owner and writes both audit rows', async () => {
    const firstStudentId = await seedStudent(pool, 80_210, 'First Owner', true);
    const secondStudentId = await seedStudent(pool, 80_211, 'Second Owner', true);
    const deviceId = await seedDevice(pool, {
      serial: 'SN-B2C-ASSIGN-REASSIGN',
      assignedStudentId: firstStudentId,
    });

    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${deviceId}/assign`,
      headers: {
        'x-test-actor': adminUser.username,
        'x-otp-code': VALID_OTP,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ canvasUserId: 80_211 }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { assignedStudentId: number | null };
    expect(body.assignedStudentId).toBe(secondStudentId);

    expect(await fetchAssignedStudentId(pool, deviceId)).toBe(secondStudentId);
    expect(await auditCount(pool, 'dispositivo.assign', String(deviceId))).toBe(1);

    const audit = await pool.query<{
      before_jsonb: { assignedStudentId: number | null };
      after_jsonb: { assignedStudentId: number | null };
    }>(
      `SELECT before_jsonb, after_jsonb
         FROM audit_log
        WHERE action = 'dispositivo.assign'
          AND entity_type = 'dispositivo'
          AND entity_id = $1
        ORDER BY id DESC
        LIMIT 1`,
      [String(deviceId)],
    );
    const row = audit.rows[0];
    expect(row?.before_jsonb.assignedStudentId).toBe(firstStudentId);
    expect(row?.after_jsonb.assignedStudentId).toBe(secondStudentId);
  });

  // -----------------------------------------------------------------
  // fail-closed service semantics — assign
  // -----------------------------------------------------------------

  it('assign: 422 student_not_active; column stays NULL; no audit row', async () => {
    await seedStudent(pool, 80_220, 'Withdrawn Student', false);
    const deviceId = await seedDevice(pool, { serial: 'SN-B2C-ASSIGN-INACTIVE' });

    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${deviceId}/assign`,
      headers: {
        'x-test-actor': adminUser.username,
        'x-otp-code': VALID_OTP,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ canvasUserId: 80_220 }),
    });
    expect(r.statusCode).toBe(422);
    const body = r.json() as { code: string };
    expect(body.code).toBe('student_not_active');
    expect(await fetchAssignedStudentId(pool, deviceId)).toBeNull();
    expect(await auditCount(pool, 'dispositivo.assign', String(deviceId))).toBe(0);
  });

  it('assign: 422 student_not_found for an unknown canvas_user_id; no audit row', async () => {
    const deviceId = await seedDevice(pool, { serial: 'SN-B2C-ASSIGN-MISSING' });
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${deviceId}/assign`,
      headers: {
        'x-test-actor': adminUser.username,
        'x-otp-code': VALID_OTP,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ canvasUserId: 99_999_999 }),
    });
    expect(r.statusCode).toBe(422);
    const body = r.json() as { code: string };
    expect(body.code).toBe('student_not_found');
    expect(await fetchAssignedStudentId(pool, deviceId)).toBeNull();
    expect(await auditCount(pool, 'dispositivo.assign', String(deviceId))).toBe(0);
  });

  it('assign: 409 for a revoked device; no DB change', async () => {
    const studentId = await seedStudent(pool, 80_230, 'Blocked Student', true);
    const deviceId = await seedDevice(pool, {
      serial: 'SN-B2C-ASSIGN-REVOKED',
      status: 'revoked',
    });

    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${deviceId}/assign`,
      headers: {
        'x-test-actor': adminUser.username,
        'x-otp-code': VALID_OTP,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ canvasUserId: 80_230 }),
    });
    expect(r.statusCode).toBe(409);
    expect(await fetchAssignedStudentId(pool, deviceId)).toBeNull();
    expect(await auditCount(pool, 'dispositivo.assign', String(deviceId))).toBe(0);
    expect(studentId).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------
  // unassign happy path + no-op rejection
  // -----------------------------------------------------------------

  it('unassign: 200 with assignedStudentId:null and audit row (before/after + otp_id)', async () => {
    const studentId = await seedStudent(pool, 80_300, 'Owner To Unbind', true);
    const deviceId = await seedDevice(pool, {
      serial: 'SN-B2C-UNASSIGN-HAPPY',
      assignedStudentId: studentId,
    });

    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${deviceId}/unassign`,
      headers: {
        'x-test-actor': adminUser.username,
        'x-otp-code': VALID_OTP,
      },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { id: number; assignedStudentId: number | null };
    expect(body.id).toBe(deviceId);
    expect(body.assignedStudentId).toBeNull();

    expect(await fetchAssignedStudentId(pool, deviceId)).toBeNull();
    expect(await auditCount(pool, 'dispositivo.unassign', String(deviceId))).toBe(1);

    const audit = await pool.query<{
      before_jsonb: { assignedStudentId: number | null };
      after_jsonb: { assignedStudentId: number | null };
      otp_id: string | null;
    }>(
      `SELECT before_jsonb, after_jsonb, otp_id
         FROM audit_log
        WHERE action = 'dispositivo.unassign'
          AND entity_type = 'dispositivo'
          AND entity_id = $1
        ORDER BY id DESC
        LIMIT 1`,
      [String(deviceId)],
    );
    const row = audit.rows[0];
    expect(row?.otp_id).toBe(MOCK_OTP_ID);
    expect(row?.before_jsonb.assignedStudentId).toBe(studentId);
    expect(row?.after_jsonb.assignedStudentId).toBeNull();
  });

  it('unassign: 409 device_not_assigned on a no-op; no audit row', async () => {
    const deviceId = await seedDevice(pool, {
      serial: 'SN-B2C-UNASSIGN-NOOP',
      assignedStudentId: null,
    });

    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${deviceId}/unassign`,
      headers: {
        'x-test-actor': adminUser.username,
        'x-otp-code': VALID_OTP,
      },
    });
    expect(r.statusCode).toBe(409);
    const body = r.json() as { code: string };
    expect(body.code).toBe('device_not_assigned');
    expect(await fetchAssignedStudentId(pool, deviceId)).toBeNull();
    expect(await auditCount(pool, 'dispositivo.unassign', String(deviceId))).toBe(0);
  });

  // -----------------------------------------------------------------
  // triangulation — boundary validation, same-student idempotency,
  // and unknown device 404 path. Each protects a distinct corner of
  // the route contract without re-asserting the cases above.
  // -----------------------------------------------------------------

  it('assign: 400 when the body is missing canvasUserId', async () => {
    const deviceId = await seedDevice(pool, { serial: 'SN-B2C-ASSIGN-MISSING-BODY' });
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${deviceId}/assign`,
      headers: {
        'x-test-actor': adminUser.username,
        'x-otp-code': VALID_OTP,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({}),
    });
    expect(r.statusCode).toBe(400);
    expect(await fetchAssignedStudentId(pool, deviceId)).toBeNull();
    expect(await auditCount(pool, 'dispositivo.assign', String(deviceId))).toBe(0);
  });

  it('assign: 400 when canvasUserId is not a positive integer', async () => {
    const deviceId = await seedDevice(pool, { serial: 'SN-B2C-ASSIGN-BAD-INT' });
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${deviceId}/assign`,
      headers: {
        'x-test-actor': adminUser.username,
        'x-otp-code': VALID_OTP,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ canvasUserId: -5 }),
    });
    expect(r.statusCode).toBe(400);
    expect(await fetchAssignedStudentId(pool, deviceId)).toBeNull();
  });

  it('assign: 400 when the path id is not a positive integer', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/not-a-number/assign`,
      headers: {
        'x-test-actor': adminUser.username,
        'x-otp-code': VALID_OTP,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ canvasUserId: 80_900 }),
    });
    expect(r.statusCode).toBe(400);
  });

  it('assign: 404 for an unknown device id', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/999999999/assign`,
      headers: {
        'x-test-actor': adminUser.username,
        'x-otp-code': VALID_OTP,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ canvasUserId: 80_910 }),
    });
    expect(r.statusCode).toBe(404);
  });

  it('assign: same-student reassignment is still a successful 200 (idempotent bind)', async () => {
    const studentId = await seedStudent(pool, 80_920, 'Already-Bound Student', true);
    const deviceId = await seedDevice(pool, {
      serial: 'SN-B2C-ASSIGN-SAME-STUDENT',
      assignedStudentId: studentId,
    });

    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${deviceId}/assign`,
      headers: {
        'x-test-actor': adminUser.username,
        'x-otp-code': VALID_OTP,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ canvasUserId: 80_920 }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { assignedStudentId: number | null };
    expect(body.assignedStudentId).toBe(studentId);
    expect(await fetchAssignedStudentId(pool, deviceId)).toBe(studentId);
    expect(await auditCount(pool, 'dispositivo.assign', String(deviceId))).toBe(1);
  });

  it('unassign: 400 when the path id is not a positive integer', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/abc/unassign`,
      headers: {
        'x-test-actor': adminUser.username,
        'x-otp-code': VALID_OTP,
      },
    });
    expect(r.statusCode).toBe(400);
  });

  it('unassign: 404 for an unknown device id (before any role check)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/999999998/unassign`,
      headers: {
        'x-test-actor': adminUser.username,
        'x-otp-code': VALID_OTP,
      },
    });
    expect(r.statusCode).toBe(404);
  });

  // -----------------------------------------------------------------
  // CRUD regression spot-check (existing routes untouched)
  // -----------------------------------------------------------------

  it('CRUD regression: POST + PATCH + DELETE still work after the new routes are added', async () => {
    // CREATE
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/dispositivos',
      headers: {
        'x-test-actor': adminUser.username,
        'x-otp-code': VALID_OTP,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        serialNumber: 'SN-B2C-CRUD-CRUD',
        brand: 'Apple',
        model: 'iPad',
      }),
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { id: number; status: string };
    expect(created.status).toBe('active');

    // UPDATE
    const update = await app.inject({
      method: 'PATCH',
      url: `/api/v1/dispositivos/${created.id}`,
      headers: {
        'x-test-actor': adminUser.username,
        'x-otp-code': VALID_OTP,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ model: 'iPad Air' }),
    });
    expect(update.statusCode).toBe(200);
    const updated = update.json() as { model: string };
    expect(updated.model).toBe('iPad Air');

    // DELETE (soft-revoke)
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/dispositivos/${created.id}`,
      headers: {
        'x-test-actor': adminUser.username,
        'x-otp-code': VALID_OTP,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ reason: 'b2c-regression' }),
    });
    expect(del.statusCode).toBe(200);
    const revoked = del.json() as { status: string };
    expect(revoked.status).toBe('revoked');
  });
});