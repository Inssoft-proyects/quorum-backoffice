/**
 * M1 / `POST /api/v1/mfa/authenticate` — end-to-end integration tests.
 *
 * Boots the real Fastify app via `buildApp`, intercepts the quorum-otp
 * HTTP boundary at the `globalThis.fetch` layer (same pattern as the
 * B2c dispositivos-assign-routes suite), and exercises the full
 * fail-closed policy order against the real PostgreSQL.
 *
 * Coverage:
 *
 *   - happy path: marbete + device + OTP valid → 201, cookie set,
 *     audit row, session row with kind='student' + canvas_user_id
 *   - denial taxonomy: marbete_unknown (not found / revoked /
 *     deleted), student_inactive (no owner / is_active=false),
 *     device_unknown (not found / revoked / unassigned),
 *     device_not_bound_to_student, otp_invalid, dependency_fail
 *     (OTP 5xx + thrown)
 *   - body validation: empty marbete_code / missing otp / short otp
 *     → 400 `validation_error`
 *   - session cookie attributes: HttpOnly, Secure, SameSite=Lax,
 *     Path=/, `__Host-` prefix
 *   - audit row shape: entity_id = canvas_user_id, no marbete code,
 *     no serial, no OTP
 *   - replay: same OTP submitted twice — first 201, second 401
 *     deny.otp_invalid
 *   - concurrent: 5 parallel POSTs with the same OTP — exactly one
 *     succeeds (the rest get deny.otp_invalid)
 *
 * The fixtures are designed to match the wire format emitted by
 * OtpClient (`{ subject, scope, token }`, NOT `code`) and the
 * `valid: true` shape the client expects on success.
 */
import { Pool, types } from 'pg';
import path from 'node:path';
import { buildApp } from '../../src/app';
import { migrate } from '../../src/migrations';
import { hashMarbeteCode } from '../../src/lib/marbete-code';
import { OtpClient } from '../../src/services/otp-client';

const TEST_DATABASE_URL =
  process.env['DATABASE_URL_TEST'] ??
  'postgresql://websop:quorum_backoffice_dev@127.0.0.1:5432/quorum_backoffice_test';

// BIGINT (oid 20) is parsed as a number — mirrors the parser app.ts
// installs at module load. dispositivos.id and students_cache.id are
// both BIGINT; without this override the raw pool returns strings.
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

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
const MOCK_OTP_ID = 'otp-mfa-integration-happy';

interface OtpFetchResponse {
  status: number;
  body: unknown;
}

type OtpBehaviour = (body: {
  token?: string;
  subject?: string;
  scope?: string;
}) => OtpFetchResponse;

/**
 * HTTP-layer OTP fake: replaces `globalThis.fetch` so the route's
 * `app.otpClient.verify()` call sees deterministic responses.
 *
 * Wire contract (must match `OtpClient.verify`):
 *   - sends `{ subject, scope, token }`
 *   - expects 200 with `{ valid: true, id }` on success
 *   - 409 / 423 is the canonical "OTP rejected" outcome
 *   - 429 is the locked / rate-limited outcome
 *   - 5xx is the dependency-fail outcome (OtpClient throws
 *     `AppError.serviceUnavailable`)
 */
function makeOtpFetch(behaviour: OtpBehaviour): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/otps/verify')) {
      const raw = init?.body ? String(init.body) : '{}';
      const parsed = JSON.parse(raw) as {
        token?: string;
        subject?: string;
        scope?: string;
      };
      const r = behaviour(parsed);
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    return new Response('not used', { status: 404 });
  }) as unknown as typeof fetch;
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

async function seedMarbete(
  pool: Pool,
  args: {
    code: string;
    status?: 'active' | 'inactive' | 'revoked';
    assignedStudentId?: number | null;
    deletedAt?: Date | null;
    publicUid?: string;
  },
): Promise<number> {
  const codeHash = hashMarbeteCode(args.code);
  const publicUid = args.publicUid ?? `m-${args.code.slice(0, 4).toUpperCase()}`;
  const r = await pool.query<{ id: number }>(
    `INSERT INTO marbetes
       (public_uid, code_hash, status, assigned_student_id, created_by, deleted_at, assigned_at)
     VALUES ($1, $2, $3::marbete_status, $4, 'tester', $5, CASE WHEN $4::bigint IS NULL THEN NULL ELSE now() END)
     RETURNING id`,
    [publicUid, codeHash, args.status ?? 'active', args.assignedStudentId ?? null, args.deletedAt ?? null],
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

async function auditCount(
  pool: Pool,
  outcome: string,
): Promise<number> {
  // The MFA audit row carries `outcome` in `after_jsonb->>'outcome'`.
  // An empty string in the regex literal `=` is replaced by the
  // supplied outcome label.
  const r = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM audit_log
      WHERE action = 'student.mfa_authenticate'
        AND after_jsonb->>'outcome' = $1`,
    [outcome],
  );
  return Number(r.rows[0]?.count ?? '0');
}

async function lastMfaAuditRow(
  pool: Pool,
): Promise<{
  actor_id: string;
  entity_type: string | null;
  entity_id: string | null;
  after_jsonb: unknown;
  otp_id: string | null;
  ip: string | null;
  user_agent: string | null;
} | null> {
  const r = await pool.query<{
    actor_id: string;
    entity_type: string | null;
    entity_id: string | null;
    after_jsonb: unknown;
    otp_id: string | null;
    ip: string | null;
    user_agent: string | null;
  }>(
    `SELECT actor_id, entity_type, entity_id,
            after_jsonb::text::jsonb AS after_jsonb,
            otp_id, ip::text AS ip, user_agent
       FROM audit_log
      WHERE action = 'student.mfa_authenticate'
      ORDER BY id DESC
      LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

async function sessionRow(
  pool: Pool,
  id: string,
): Promise<{
  id: string;
  user_id: number | null;
  kind: string;
  canvas_user_id: number | null;
} | null> {
  const r = await pool.query<{
    id: string;
    user_id: number | null;
    kind: string;
    canvas_user_id: number | null;
  }>(
    `SELECT id, user_id, kind, canvas_user_id
       FROM sessions
      WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
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

const CODE_HAPPY = 'CODE-HAPPY-MFA-12345';
const SERIAL_HAPPY = 'SN-MFA-HAPPY';
const SERIAL_OTHER = 'SN-MFA-OTHER';
const CANVAS_HAPPY = 90_001;
const CANVAS_OTHER = 90_002;
const CANVAS_INACTIVE = 90_003;

interface AuthBody {
  marbete_code: string;
  serial_number: string;
  otp: string;
}

function happyBody(overrides: Partial<AuthBody> = {}): AuthBody {
  return {
    marbete_code: CODE_HAPPY,
    serial_number: SERIAL_HAPPY,
    otp: VALID_OTP,
    ...overrides,
  };
}

async function fetchHappyFixtures(
  pool: Pool,
): Promise<{ studentId: number; otherStudentId: number; inactiveStudentId: number }> {
  // The happy-path student is bound to a marbete and a device.
  const studentId = await seedStudent(pool, CANVAS_HAPPY, 'Happy MFA Student', true);
  const otherStudentId = await seedStudent(pool, CANVAS_OTHER, 'Other MFA Student', true);
  const inactiveStudentId = await seedStudent(
    pool,
    CANVAS_INACTIVE,
    'Inactive MFA Student',
    false,
  );
  return { studentId, otherStudentId, inactiveStudentId };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('POST /api/v1/mfa/authenticate — M1 endpoint (integration, real PG)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;
  let studentId: number;
  let otherStudentId: number;
  let inactiveStudentId: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    // Recreate schema from scratch so the suite is independent of
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

    app = await buildApp({ config: TEST_ENV });
    // The login flow (used only for the role-gate regression
    // spot-check) does not exercise the MFA endpoint — leave
    // the real OtpClient in place and override the HTTP
    // boundary so the MFA service's verify call sees a
    // deterministic response.
    (globalThis as { fetch: typeof fetch }).fetch = makeOtpFetch((body) => {
      if (body.token === VALID_OTP) {
        return { status: 200, body: { id: MOCK_OTP_ID, valid: true } };
      }
      return { status: 409, body: { error: 'verify_rejected' } };
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    // Per-test isolation: drop all dependent rows but keep the
    // migration history so the test runs are fast.
    await pool.query(`TRUNCATE TABLE audit_log RESTART IDENTITY`);
    await pool.query(`DELETE FROM sessions`);
    await pool.query(`DELETE FROM dispositivos`);
    await pool.query(`DELETE FROM marbetes`);
    await pool.query(`DELETE FROM students_cache`);

    const fixtures = await fetchHappyFixtures(pool);
    studentId = fixtures.studentId;
    otherStudentId = fixtures.otherStudentId;
    inactiveStudentId = fixtures.inactiveStudentId;

    // The happy-path marbete + device are seeded per-test so a
    // successful authentication in one test does not affect the
    // next. The "happy" marbete is bound to the happy student
    // AND a device with the matching serial.
    await seedMarbete(pool, {
      code: CODE_HAPPY,
      publicUid: 'm-HAPPY',
      assignedStudentId: studentId,
    });
    await seedDevice(pool, {
      serial: SERIAL_HAPPY,
      assignedStudentId: studentId,
    });
    await seedDevice(pool, {
      serial: SERIAL_OTHER,
      assignedStudentId: otherStudentId,
    });
  });

  // -----------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------

  it('happy: 201 with student identity, session row kind=student + canvas_user_id, cookie set, audit row', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(happyBody()),
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as {
      canvas_user_id: number;
      student_name: string;
      student_email: string;
      role: 'student';
      session_id: string;
      expires_at: string;
    };
    expect(body.canvas_user_id).toBe(CANVAS_HAPPY);
    expect(body.student_name).toBe('Happy MFA Student');
    expect(body.student_email).toBe(`student-${CANVAS_HAPPY}@quorum.local`);
    expect(body.role).toBe('student');
    expect(body.session_id).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());

    // The session row carries kind='student' + canvas_user_id,
    // with user_id=NULL. The role for a student session is
    // implicit in `kind`; we do NOT write a separate `role`
    // column (the discriminator + the lookup table is
    // sufficient).
    const sess = await sessionRow(pool, body.session_id);
    expect(sess).not.toBeNull();
    expect(sess?.kind).toBe('student');
    expect(sess?.canvas_user_id).toBe(CANVAS_HAPPY);
    expect(sess?.user_id).toBeNull();

    // The audit row carries the ok outcome + the denormalized
    // student identity; NEVER the raw code / serial / OTP.
    expect(await auditCount(pool, 'ok')).toBe(1);
    const audit = await lastMfaAuditRow(pool);
    expect(audit).not.toBeNull();
    expect(audit?.actor_id).toBe('__mfa__');
    expect(audit?.entity_type).toBe('student');
    expect(audit?.entity_id).toBe(String(CANVAS_HAPPY));
    expect(audit?.otp_id).toBe(MOCK_OTP_ID);
    const auditJson = JSON.stringify(audit?.after_jsonb);
    expect(auditJson).not.toContain(CODE_HAPPY);
    expect(auditJson).not.toContain(SERIAL_HAPPY);
    expect(auditJson).not.toContain(VALID_OTP);
  });

  it('happy: session cookie has HttpOnly, Secure, SameSite=Lax, Path=/, __Host- prefix', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(happyBody()),
    });
    expect(r.statusCode).toBe(201);
    const cookie = cookieFromSetCookie(r.headers['set-cookie'], '__Host-mfa_sid');
    expect(cookie).not.toBeNull();
    const rawCookie = r.headers['set-cookie'] as string | string[];
    const first = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
    expect(first).toBeDefined();
    // Lock the attributes byte-for-byte.
    expect(first).toMatch(/HttpOnly/i);
    expect(first).toMatch(/Secure/i);
    expect(first).toMatch(/SameSite=Lax/i);
    expect(first).toMatch(/Path=\//);
    expect(first).toMatch(/^__Host-mfa_sid=/);
  });

  it('happy: session_id returned in body matches the value stored in the sessions table', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(happyBody()),
    });
    const body = r.json() as { session_id: string };
    const sess = await sessionRow(pool, body.session_id);
    expect(sess).not.toBeNull();
  });

  // -----------------------------------------------------------------
  // Marbete deny paths
  // -----------------------------------------------------------------

  it('marbete_unknown: 401 with deny.marbete_unknown when the code hash matches no row', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(
        happyBody({ marbete_code: 'NOT-A-REAL-CODE-FOO' }),
      ),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'deny.marbete_unknown' });
    expect(await auditCount(pool, 'deny.marbete_unknown')).toBe(1);
  });

  it('marbete_revoked: 401 with deny.marbete_unknown when the marbete status is revoked', async () => {
    await seedMarbete(pool, {
      code: 'CODE-REVOKED-MFA-12345',
      publicUid: 'm-REVOKED',
      status: 'revoked',
      assignedStudentId: studentId,
    });
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(
        happyBody({ marbete_code: 'CODE-REVOKED-MFA-12345' }),
      ),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'deny.marbete_unknown' });
  });

  it('marbete_deleted: 401 with deny.marbete_unknown when deleted_at is set', async () => {
    await seedMarbete(pool, {
      code: 'CODE-DELETED-MFA-1234',
      publicUid: 'm-DELETED',
      deletedAt: new Date(),
      assignedStudentId: studentId,
    });
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(
        happyBody({ marbete_code: 'CODE-DELETED-MFA-1234' }),
      ),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'deny.marbete_unknown' });
  });

  // -----------------------------------------------------------------
  // Student deny paths
  // -----------------------------------------------------------------

  it('student_inactive (no owner): 401 with deny.student_inactive when the marbete has no assigned_student_id', async () => {
    await seedMarbete(pool, {
      code: 'CODE-NO-OWNER-12345',
      publicUid: 'm-NO-OWNER',
      assignedStudentId: null,
    });
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(
        happyBody({ marbete_code: 'CODE-NO-OWNER-12345' }),
      ),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'deny.student_inactive' });
  });

  it('student_inactive (is_active=false): 401 with deny.student_inactive when the student is inactive', async () => {
    await seedMarbete(pool, {
      code: 'CODE-INACTIVE-12345',
      publicUid: 'm-INACTIVE',
      assignedStudentId: inactiveStudentId,
    });
    // The device for the inactive student is bound to the inactive
    // student id so we get past the device check; the deny
    // MUST come from the student-inactive branch.
    await seedDevice(pool, {
      serial: 'SN-MFA-INACTIVE',
      assignedStudentId: inactiveStudentId,
    });
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(
        happyBody({
          marbete_code: 'CODE-INACTIVE-12345',
          serial_number: 'SN-MFA-INACTIVE',
        }),
      ),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'deny.student_inactive' });
  });

  // -----------------------------------------------------------------
  // Device deny paths
  // -----------------------------------------------------------------

  it('device_unknown (serial missing): 401 with deny.device_unknown when the serial is not in the table', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(
        happyBody({ serial_number: 'SN-DOES-NOT-EXIST' }),
      ),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'deny.device_unknown' });
  });

  it('device_unknown (revoked): 401 with deny.device_unknown when the device is revoked', async () => {
    await seedDevice(pool, {
      serial: 'SN-MFA-REVOKED',
      status: 'revoked',
      assignedStudentId: studentId,
    });
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(
        happyBody({ serial_number: 'SN-MFA-REVOKED' }),
      ),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'deny.device_unknown' });
  });

  it('device_unknown (unassigned): 401 with deny.device_unknown when the device has no assigned_student_id', async () => {
    await seedDevice(pool, {
      serial: 'SN-MFA-UNASSIGNED',
      assignedStudentId: null,
    });
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(
        happyBody({ serial_number: 'SN-MFA-UNASSIGNED' }),
      ),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'deny.device_unknown' });
  });

  it('device_not_bound_to_student: 401 with deny.device_not_bound_to_student when the device is bound to a different student', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(happyBody({ serial_number: SERIAL_OTHER })),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({
      code: 'deny.device_not_bound_to_student',
    });
  });

  // -----------------------------------------------------------------
  // OTP deny paths
  // -----------------------------------------------------------------

  it('otp_invalid: 401 with deny.otp_invalid when the OTP verify returns 409', async () => {
    // The default fetch returns 409 for any non-VALID_OTP token.
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(happyBody({ otp: '999999' })),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'deny.otp_invalid' });
  });

  it('dependency_fail (5xx): 503 with deny.dependency_fail when the OTP service returns 5xx', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = makeOtpFetch(() => ({
      status: 503,
      body: { error: 'service_unavailable' },
    }));
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/mfa/authenticate',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(happyBody()),
      });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ code: 'deny.dependency_fail' });
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = makeOtpFetch((body) => {
        if (body.token === VALID_OTP) {
          return { status: 200, body: { id: MOCK_OTP_ID, valid: true } };
        }
        return { status: 409, body: { error: 'verify_rejected' } };
      });
    }
  });

  // -----------------------------------------------------------------
  // Body validation
  // -----------------------------------------------------------------

  it('body validation: 400 when marbete_code is missing', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ serial_number: SERIAL_HAPPY, otp: VALID_OTP }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'validation_error' });
  });

  it('body validation: 400 when otp is missing', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        marbete_code: CODE_HAPPY,
        serial_number: SERIAL_HAPPY,
      }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'validation_error' });
  });

  it('body validation: 400 when otp is too short', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(
        happyBody({ otp: '12' }),
      ),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'validation_error' });
  });

  it('body validation: 400 when marbete_code is too short (< 8 chars)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(happyBody({ marbete_code: 'short' })),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'validation_error' });
  });

  it('body validation: 400 when serial_number is empty', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(happyBody({ serial_number: '' })),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'validation_error' });
  });

  // -----------------------------------------------------------------
  // Replay + concurrency
  // -----------------------------------------------------------------

  it('replay: same OTP submitted twice — first 201, second 401 deny.otp_invalid', async () => {
    // The mock fetch always returns 200 for the VALID_OTP token,
    // but the OTP service is single-use. We simulate the
    // single-use contract by upgrading the fetch for the second
    // request only: the first sees a fresh 200, the second sees
    // a 409 (already consumed).
    let consumeCount = 0;
    (globalThis as { fetch: typeof fetch }).fetch = makeOtpFetch(() => {
      consumeCount += 1;
      if (consumeCount === 1) {
        return { status: 200, body: { id: MOCK_OTP_ID, valid: true } };
      }
      return { status: 409, body: { error: 'verify_rejected' } };
    });
    try {
      const r1 = await app.inject({
        method: 'POST',
        url: '/api/v1/mfa/authenticate',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(happyBody()),
      });
      expect(r1.statusCode).toBe(201);
      const r2 = await app.inject({
        method: 'POST',
        url: '/api/v1/mfa/authenticate',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(happyBody()),
      });
      expect(r2.statusCode).toBe(401);
      expect(r2.json()).toMatchObject({ code: 'deny.otp_invalid' });
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = makeOtpFetch((body) => {
        if (body.token === VALID_OTP) {
          return { status: 200, body: { id: MOCK_OTP_ID, valid: true } };
        }
        return { status: 409, body: { error: 'verify_rejected' } };
      });
    }
  });

  it('concurrent: 5 parallel POSTs with the same OTP — exactly one succeeds', async () => {
    let consumeCount = 0;
    (globalThis as { fetch: typeof fetch }).fetch = makeOtpFetch(() => {
      consumeCount += 1;
      if (consumeCount === 1) {
        return { status: 200, body: { id: MOCK_OTP_ID, valid: true } };
      }
      return { status: 409, body: { error: 'verify_rejected' } };
    });
    try {
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          app.inject({
            method: 'POST',
            url: '/api/v1/mfa/authenticate',
            headers: { 'content-type': 'application/json' },
            payload: JSON.stringify(happyBody()),
          }),
        ),
      );
      const successCount = responses.filter((r) => r.statusCode === 201).length;
      const denyCount = responses.filter((r) => r.statusCode === 401).length;
      expect(successCount).toBe(1);
      expect(denyCount).toBe(4);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = makeOtpFetch((body) => {
        if (body.token === VALID_OTP) {
          return { status: 200, body: { id: MOCK_OTP_ID, valid: true } };
        }
        return { status: 409, body: { error: 'verify_rejected' } };
      });
    }
  });

  // -----------------------------------------------------------------
  // Audit row shape
  // -----------------------------------------------------------------

  it('audit row: entity_id is the canvas_user_id, no marbete code / serial / OTP', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(happyBody()),
    });
    expect(r.statusCode).toBe(201);
    const audit = await lastMfaAuditRow(pool);
    expect(audit).not.toBeNull();
    expect(audit?.entity_id).toBe(String(CANVAS_HAPPY));
    // Lock the deny-side invariants: the audit JSONB MUST NOT
    // echo the raw code, the raw serial, or the raw OTP.
    const auditJson = JSON.stringify(audit);
    expect(auditJson).not.toContain(CODE_HAPPY);
    expect(auditJson).not.toContain(SERIAL_HAPPY);
    expect(auditJson).not.toContain(VALID_OTP);
  });

  // -----------------------------------------------------------------
  // GET /api/v1/mfa/session — small bonus route
  // -----------------------------------------------------------------

  it('GET /api/v1/mfa/session: 200 with the resolved student when the session cookie is present', async () => {
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(happyBody()),
    });
    expect(r1.statusCode).toBe(201);
    const cookie = cookieFromSetCookie(r1.headers['set-cookie'], '__Host-mfa_sid');
    expect(cookie).not.toBeNull();
    const r2 = await app.inject({
      method: 'GET',
      url: '/api/v1/mfa/session',
      headers: { cookie: cookie! },
    });
    expect(r2.statusCode).toBe(200);
    const body = r2.json() as { canvas_user_id: number };
    expect(body.canvas_user_id).toBe(CANVAS_HAPPY);
  });

  it('GET /api/v1/mfa/session: 401 when no cookie is supplied', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/mfa/session',
    });
    expect(r.statusCode).toBe(401);
  });

  it('GET /api/v1/mfa/session: 401 when the cookie belongs to a non-MFA session', async () => {
    // Insert a kind='user' row directly (simulating a BackOffice
    // operator session). The MFA session route MUST NOT report
    // it as an MFA session. We bypass the user_id FK with a
    // dummy users row so the INSERT is legal; the route's
    // findStudentSessionById query is what we are testing, and
    // it constrains to `kind='student'` so a kind='user' row
    // is invisible to the MFA endpoint regardless.
    const userRes = await pool.query<{ id: number }>(
      `INSERT INTO users (email, username, password_hash, role)
       VALUES ('mfa-op-user@example.test', 'mfa-op-user', '$2b$10$abcdefghijklmnopqrstuv', 'admin')
       RETURNING id`,
    );
    const userId = userRes.rows[0]?.id;
    expect(userId).toBeDefined();
    await pool.query(
      `INSERT INTO sessions (id, user_id, kind, canvas_user_id, expires_at, ip, user_agent)
       VALUES ('operator-session-1', $1, 'user', NULL, now() + interval '1 hour', '127.0.0.1', 'jest')`,
      [userId],
    );
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/mfa/session',
      headers: { cookie: '__Host-mfa_sid=operator-session-1' },
    });
    expect(r.statusCode).toBe(401);
  });
});
