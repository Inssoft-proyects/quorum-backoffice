/**
 * B3.2 / `POST /api/v1/access-decisions` — end-to-end integration tests.
 *
 * Boots the real Fastify app via `buildApp`, signs HMAC requests with the
 * shared helpers from `apps/api/src/lib/service-hmac.ts`, and exercises
 * the full HTTP envelope over the real PostgreSQL. Covers:
 *
 *   (a) auth matrix: missing header / unknown name / bad signature /
 *       stale ts → 401 deny.idp_untrusted (every transport auth failure
 *       collapses to the same wire code)
 *   (b) deny matrix over seeded fixtures: otp_missing, otp_invalid
 *       (mocked verify reject), otp_locked (429 mock), dependency_fail
 *       (mocked 5xx), device_unknown (unassigned device, revoked
 *       device, wrong canvas user, inactive student — all uniformly
 *       device_unknown)
 *   (c) allow path: active student + assigned active device + valid
 *       OTP → 200 { decision: 'allow', student_id }
 *   (d) serial-leak guard: JSON.stringify(response) never contains the
 *       seeded device serial on any deny path
 *   (e) empty BACKOFFICE_SERVICE_TOKENS registry → 401 for everything
 *       (fail-closed)
 *
 * The HTTP-layer OTP fake is a globalThis.fetch override that mirrors
 * the B2c pattern (see dispositivos-assign-routes.test.ts). It MUST
 * return `{ id, valid: true }` on success; the older fixtures in
 * rbac.test.ts/dispositivos.test.ts that only return `{ id }` are
 * known-broken (OtpClient requires `valid: true`) and must NOT be
 * copied here.
 *
 * The signature for every authenticated request is computed with
 * hmacSign(secret, ts, rawJsonBody) over the EXACT bytes that
 * `app.inject({ payload })` sends. captureRawBodyPlugin stashes
 * `req.rawBody` before JSON parse so the verifier signs over the same
 * bytes the sender signed.
 */
import { Pool, types } from 'pg';
import path from 'node:path';
import { buildApp } from '../../src/app';
import { migrate } from '../../src/migrations';
import { hmacSign } from '../../src/lib/service-hmac';
import { parseServiceTokens } from '../../src/plugins/service-auth';
import { resetConfigForTests } from '../../src/config';

const TEST_DATABASE_URL =
  process.env['DATABASE_URL_TEST'] ??
  'postgresql://websop:quorum_backoffice_dev@127.0.0.1:5432/quorum_backoffice_test';

// BIGINT (oid 20) is parsed as a number — mirrors the parser app.ts
// installs at module load. dispositivos.id and students_cache.id are
// both BIGINT; without this override the raw pool returns strings.
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

const TEST_ENV_BASE: NodeJS.ProcessEnv = {
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

const SVC_NAME = 'canvas-portal';
const SVC_SECRET = 'integration-shared-secret-1';
const SKEW = 60;
const VALID_OTP = '123456';
const MOCK_OTP_ID = 'otp-b32-integration';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface OtpFetchResponse {
  status: number;
  body: unknown;
}

type OtpBehaviour = (body: { token?: string; subject?: string; scope?: string }) => OtpFetchResponse;

/**
 * HTTP-layer OTP fake: replaces globalThis.fetch so the OtpClient
 * constructed inside `registerAccessDecisionsRoutes` sees deterministic
 * responses. Mirrors the B2c pattern in dispositivos-assign-routes.test.ts:
 *
 *   - the wire contract is `{ subject, scope, token }` (NOT `code`),
 *   - the success body MUST be `{ id, valid: true }` so OtpClient's
 *     `body.valid !== true` guard is satisfied,
 *   - 409 = invalid, 429 = locked, 5xx = empty (the caller marks it as
 *     a thrown dependency failure via the OtpClient sender path),
 *   - everything else returns 200 with `valid: false` so OtpClient
 *     maps to `unknown` (treated as dependency_fail by the service).
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
    [args.serial, args.status ?? 'active', args.assignedStudentId ?? null, null],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('device_seed_failed');
  if (args.status === 'revoked') {
    await pool.query(
      `UPDATE dispositivos
          SET status = 'revoked', revoked_at = now(), revoked_reason = 'test'
        WHERE id = $1`,
      [id],
    );
  }
  return id;
}

interface SignedRequestOptions {
  body?: string;
  ts?: number;
  serviceName?: string;
  secret?: string;
  /** Provide an explicit Authorization header to test malformed inputs. */
  authorizationOverride?: string;
}

/**
 * Sign a JSON body under the integration shared secret and POST it to
 * the access-decision endpoint. Returns the raw inject response so the
 * caller can assert on status + parsed body.
 */
async function postSigned(
  app: Awaited<ReturnType<typeof buildApp>>,
  url: string,
  opts: SignedRequestOptions = {},
) {
  const body = opts.body ?? JSON.stringify({
    device_id: 'unused',
    otp_proof: VALID_OTP,
    canvas_user_id: 1,
  });
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const sig = hmacSign(opts.secret ?? SVC_SECRET, ts, body);
  const authorization =
    opts.authorizationOverride ??
    `HMAC ${opts.serviceName ?? SVC_NAME} ${ts} ${sig}`;
  return app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      authorization,
    },
    payload: body,
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('POST /api/v1/access-decisions — B3.2 endpoint (integration, real PG)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;
  let TEST_ENV: NodeJS.ProcessEnv;

  beforeAll(async () => {
    TEST_ENV = {
      ...TEST_ENV_BASE,
      BACKOFFICE_SERVICE_TOKENS: `${SVC_NAME}:${SVC_SECRET}`,
      BACKOFFICE_SERVICE_HMAC_SKEW_SECONDS: String(SKEW),
    };
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
    // Default OTP transport: accept VALID_OTP, reject anything else
    // with 409 (the canonical "OTP rejected" outcome). Individual
    // tests override this via fetchReplace() for the 429 / 5xx paths.
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
    await pool.query(`TRUNCATE TABLE audit_log RESTART IDENTITY`);
    await pool.query(`DELETE FROM dispositivos`);
    await pool.query(`DELETE FROM students_cache`);
  });

  // ---------------------------------------------------------------------
  // (a) auth matrix — every transport auth failure collapses to 401
  // ---------------------------------------------------------------------

  it('(a1) 401 deny.idp_untrusted when the Authorization header is missing', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/access-decisions',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        device_id: 'SN-AUTH-1',
        otp_proof: VALID_OTP,
        canvas_user_id: 70_001,
      }),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  it('(a2) 401 deny.idp_untrusted for an unknown service name', async () => {
    const r = await postSigned(app, '/api/v1/access-decisions', {
      serviceName: 'unknown-svc',
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  it('(a3) 401 deny.idp_untrusted for a tampered signature', async () => {
    const r = await postSigned(app, '/api/v1/access-decisions', {
      secret: 'a-completely-different-secret-32-bytes!',
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  it('(a4) 401 deny.idp_untrusted for a stale timestamp beyond the skew window', async () => {
    const r = await postSigned(app, '/api/v1/access-decisions', {
      ts: Math.floor(Date.now() / 1000) - (SKEW + 30),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  // ---------------------------------------------------------------------
  // (b) deny matrix over seeded fixtures
  // ---------------------------------------------------------------------

  it('(b1) 200 {decision:deny, denial:deny.otp_missing} when otp_proof is empty', async () => {
    const studentId = await seedStudent(pool, 70_100, 'OTP Missing Student', true);
    const serial = 'SN-B-OTP-MISSING';
    await seedDevice(pool, { serial, assignedStudentId: studentId });
    const body = JSON.stringify({ device_id: serial, otp_proof: '', canvas_user_id: 70_100 });
    const r = await postSigned(app, '/api/v1/access-decisions', { body });
    expect(r.statusCode).toBe(200);
    const j = r.json() as { decision: string; denial: string | null; student_id: number | null };
    expect(j.decision).toBe('deny');
    expect(j.denial).toBe('deny.otp_missing');
    expect(j.student_id).toBeNull();
    expect(JSON.stringify(j)).not.toContain(serial);
  });

  it('(b2) 200 {denial:deny.otp_invalid} when the OTP verify provider returns 409', async () => {
    const studentId = await seedStudent(pool, 70_110, 'OTP Invalid Student', true);
    const serial = 'SN-B-OTP-INVALID';
    await seedDevice(pool, { serial, assignedStudentId: studentId });
    // Default fetch: anything that isn't the right token returns 409.
    const body = JSON.stringify({
      device_id: serial,
      otp_proof: '999999',
      canvas_user_id: 70_110,
    });
    const r = await postSigned(app, '/api/v1/access-decisions', { body });
    expect(r.statusCode).toBe(200);
    const j = r.json() as { decision: string; denial: string | null };
    expect(j.decision).toBe('deny');
    expect(j.denial).toBe('deny.otp_invalid');
    expect(JSON.stringify(j)).not.toContain(serial);
  });

  it('(b3) 200 {denial:deny.lockout} when the OTP verify provider returns 429', async () => {
    // Override the default fetch so verify returns 429 → OtpClient maps
    // to {ok:false, reason:"locked"} → service maps to deny.lockout.
    (globalThis as { fetch: typeof fetch }).fetch = makeOtpFetch(() => ({
      status: 429,
      body: { error: 'rate_limited' },
    }));
    try {
      const studentId = await seedStudent(pool, 70_120, 'Lockout Student', true);
      const serial = 'SN-B-LOCKOUT';
      await seedDevice(pool, { serial, assignedStudentId: studentId });
      const body = JSON.stringify({
        device_id: serial,
        otp_proof: VALID_OTP,
        canvas_user_id: 70_120,
      });
      const r = await postSigned(app, '/api/v1/access-decisions', { body });
      expect(r.statusCode).toBe(200);
      const j = r.json() as { decision: string; denial: string | null };
      expect(j.decision).toBe('deny');
      expect(j.denial).toBe('deny.lockout');
      expect(JSON.stringify(j)).not.toContain(serial);
    } finally {
      // Restore the default for the next test.
      (globalThis as { fetch: typeof fetch }).fetch = makeOtpFetch((body) => {
        if (body.token === VALID_OTP) {
          return { status: 200, body: { id: MOCK_OTP_ID, valid: true } };
        }
        return { status: 409, body: { error: 'verify_rejected' } };
      });
    }
  });

  it('(b4) 200 {denial:deny.dependency_fail} when the OTP verify provider returns 5xx', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = makeOtpFetch(() => ({
      status: 503,
      body: { error: 'service_unavailable' },
    }));
    try {
      const studentId = await seedStudent(pool, 70_130, 'Dependency Fail Student', true);
      const serial = 'SN-B-DEP-FAIL';
      await seedDevice(pool, { serial, assignedStudentId: studentId });
      const body = JSON.stringify({
        device_id: serial,
        otp_proof: VALID_OTP,
        canvas_user_id: 70_130,
      });
      const r = await postSigned(app, '/api/v1/access-decisions', { body });
      expect(r.statusCode).toBe(200);
      const j = r.json() as { decision: string; denial: string | null };
      expect(j.decision).toBe('deny');
      expect(j.denial).toBe('deny.dependency_fail');
      expect(JSON.stringify(j)).not.toContain(serial);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = makeOtpFetch((body) => {
        if (body.token === VALID_OTP) {
          return { status: 200, body: { id: MOCK_OTP_ID, valid: true } };
        }
        return { status: 409, body: { error: 'verify_rejected' } };
      });
    }
  });

  it('(b5a) device_unknown (uniform) for an UNASSIGNED device', async () => {
    const studentId = await seedStudent(pool, 70_200, 'Unassigned Device Student', true);
    const serial = 'SN-B-UNASSIGNED';
    await seedDevice(pool, { serial, assignedStudentId: null });
    expect(studentId).toBeGreaterThan(0); // referenced by the seed
    const body = JSON.stringify({
      device_id: serial,
      otp_proof: VALID_OTP,
      canvas_user_id: 70_200,
    });
    const r = await postSigned(app, '/api/v1/access-decisions', { body });
    expect(r.statusCode).toBe(200);
    const j = r.json() as { decision: string; denial: string | null };
    expect(j.decision).toBe('deny');
    expect(j.denial).toBe('deny.device_unknown');
    expect(JSON.stringify(j)).not.toContain(serial);
  });

  it('(b5b) device_unknown (uniform) for a REVOKED device', async () => {
    const studentId = await seedStudent(pool, 70_210, 'Revoked Device Student', true);
    const serial = 'SN-B-REVOKED';
    await seedDevice(pool, { serial, status: 'revoked', assignedStudentId: studentId });
    const body = JSON.stringify({
      device_id: serial,
      otp_proof: VALID_OTP,
      canvas_user_id: 70_210,
    });
    const r = await postSigned(app, '/api/v1/access-decisions', { body });
    expect(r.statusCode).toBe(200);
    const j = r.json() as { decision: string; denial: string | null };
    expect(j.decision).toBe('deny');
    expect(j.denial).toBe('deny.device_unknown');
    expect(JSON.stringify(j)).not.toContain(serial);
  });

  it('(b5c) device_unknown (uniform) for a WRONG canvas_user_id', async () => {
    const studentId = await seedStudent(pool, 70_220, 'Right Owner', true);
    await seedStudent(pool, 70_221, 'Other Owner', true);
    const serial = 'SN-B-WRONG-OWNER';
    await seedDevice(pool, { serial, assignedStudentId: studentId });
    const body = JSON.stringify({
      device_id: serial,
      otp_proof: VALID_OTP,
      canvas_user_id: 70_221, // different from the assigned student
    });
    const r = await postSigned(app, '/api/v1/access-decisions', { body });
    expect(r.statusCode).toBe(200);
    const j = r.json() as { decision: string; denial: string | null };
    expect(j.decision).toBe('deny');
    expect(j.denial).toBe('deny.device_unknown');
    expect(JSON.stringify(j)).not.toContain(serial);
  });

  it('(b5d) device_unknown (uniform) for an INACTIVE student', async () => {
    const studentId = await seedStudent(pool, 70_230, 'Inactive Owner', false);
    const serial = 'SN-B-INACTIVE';
    await seedDevice(pool, { serial, assignedStudentId: studentId });
    const body = JSON.stringify({
      device_id: serial,
      otp_proof: VALID_OTP,
      canvas_user_id: 70_230,
    });
    const r = await postSigned(app, '/api/v1/access-decisions', { body });
    expect(r.statusCode).toBe(200);
    const j = r.json() as { decision: string; denial: string | null };
    expect(j.decision).toBe('deny');
    expect(j.denial).toBe('deny.device_unknown');
    expect(JSON.stringify(j)).not.toContain(serial);
  });

  it('(b5e) device_unknown (uniform) for a MISSING device (serial not in table)', async () => {
    await seedStudent(pool, 70_240, 'Phantom Device Student', true);
    const body = JSON.stringify({
      device_id: 'SN-B-DOES-NOT-EXIST',
      otp_proof: VALID_OTP,
      canvas_user_id: 70_240,
    });
    const r = await postSigned(app, '/api/v1/access-decisions', { body });
    expect(r.statusCode).toBe(200);
    const j = r.json() as { decision: string; denial: string | null };
    expect(j.decision).toBe('deny');
    expect(j.denial).toBe('deny.device_unknown');
    expect(JSON.stringify(j)).not.toContain('SN-B-DOES-NOT-EXIST');
  });

  // ---------------------------------------------------------------------
  // (c) allow path
  // ---------------------------------------------------------------------

  it('(c1) 200 {decision:allow, student_id} for active student + assigned active device + valid OTP', async () => {
    const studentId = await seedStudent(pool, 70_300, 'Happy Path Student', true);
    const serial = 'SN-C-HAPPY';
    await seedDevice(pool, { serial, assignedStudentId: studentId });
    const body = JSON.stringify({
      device_id: serial,
      otp_proof: VALID_OTP,
      canvas_user_id: 70_300,
      room_id: 'room-jitsi-1',
      media_policy: 'allow_mic_camera',
    });
    const r = await postSigned(app, '/api/v1/access-decisions', { body });
    expect(r.statusCode).toBe(200);
    const j = r.json() as {
      decision: string;
      student_id: number | null;
      denial: string | null;
      room_id?: string;
      media_policy?: string;
    };
    expect(j.decision).toBe('allow');
    expect(j.student_id).toBe(studentId);
    expect(j.denial).toBeNull();
    expect(j.room_id).toBe('room-jitsi-1');
    expect(j.media_policy).toBe('allow_mic_camera');
  });

  // ---------------------------------------------------------------------
  // (d) serial-leak guard (whole-suite)
  // ---------------------------------------------------------------------

  it('(d) every deny-path fixture returns a body that does NOT contain the seeded serial', async () => {
    const scenarios: Array<{
      label: string;
      deviceStatus?: 'active' | 'revoked';
      assignedStudentId?: number | null;
      studentActive?: boolean;
      otp?: string;
      expectDenial: string;
    }> = [
      // otp_missing — empty otp_proof (provider sees no token and never runs)
      {
        label: 'otp_missing',
        deviceStatus: 'active',
        assignedStudentId: null,
        studentActive: true,
        otp: '',
        expectDenial: 'deny.otp_missing',
      },
      // otp_invalid — 409 from provider
      {
        label: 'otp_invalid',
        deviceStatus: 'active',
        assignedStudentId: null,
        studentActive: true,
        otp: 'bad',
        expectDenial: 'deny.otp_invalid',
      },
      // device_unknown — unassigned device
      {
        label: 'device_unknown_unassigned',
        deviceStatus: 'active',
        assignedStudentId: null,
        studentActive: true,
        otp: VALID_OTP,
        expectDenial: 'deny.device_unknown',
      },
      // device_unknown — revoked device
      {
        label: 'device_unknown_revoked',
        deviceStatus: 'revoked',
        assignedStudentId: null,
        studentActive: true,
        otp: VALID_OTP,
        expectDenial: 'deny.device_unknown',
      },
      // device_unknown — inactive student
      {
        label: 'device_unknown_inactive',
        deviceStatus: 'active',
        assignedStudentId: null,
        studentActive: false,
        otp: VALID_OTP,
        expectDenial: 'deny.device_unknown',
      },
      // device_unknown — missing device
      {
        label: 'device_unknown_missing',
        deviceStatus: undefined,
        assignedStudentId: undefined,
        studentActive: true,
        otp: VALID_OTP,
        expectDenial: 'deny.device_unknown',
      },
    ];
    for (const sc of scenarios) {
      // Fresh student + serial per scenario so the leak guard is tight.
      const canvasId = 70_400 + scenarios.indexOf(sc);
      const studentId = await seedStudent(
        pool,
        canvasId,
        `Leak-${sc.label}`,
        sc.studentActive ?? true,
      );
      const serial = `SN-D-LEAK-${sc.label.toUpperCase()}`;
      if (sc.deviceStatus !== undefined) {
        await seedDevice(pool, {
          serial,
          status: sc.deviceStatus,
          // Explicit assignment takes precedence (a `null` in the
          // scenario means "force unassigned"); otherwise bind to
          // the fresh student when the scenario needs a valid owner.
          assignedStudentId:
            sc.assignedStudentId !== undefined
              ? sc.assignedStudentId
              : sc.studentActive
                ? studentId
                : null,
        });
      }
      const body = JSON.stringify({
        device_id: sc.deviceStatus === undefined ? 'SN-D-LEAK-NEVER' : serial,
        otp_proof: sc.otp,
        canvas_user_id: canvasId,
      });
      const r = await postSigned(app, '/api/v1/access-decisions', { body });
      const j = r.json() as { decision: string; denial: string | null };
      expect(r.statusCode).toBe(200);
      expect(j.decision).toBe('deny');
      expect(j.denial).toBe(sc.expectDenial);
      const serialized = JSON.stringify(j);
      expect(serialized).not.toContain(serial);
      // Also assert no device-id-keyed leakage of the input device_id
      // even if the serial matched nothing in the DB.
      expect(serialized).not.toContain('SN-D-LEAK-NEVER');
    }
  });

  // ---------------------------------------------------------------------
  // (e) empty BACKOFFICE_SERVICE_TOKENS registry — fail-closed
  // ---------------------------------------------------------------------

  it('(e) empty BACKOFFICE_SERVICE_TOKENS registry → 401 for every call (fail-closed)', async () => {
    // Build a SECOND app whose env strips the token registry. The
    // registered route must remain closed even when a fully-formed
    // signature is presented — an empty registry means "trust no one".
    // Config is cached globally by `loadConfig`; clear it before the
    // second buildApp call so the empty registry actually reaches the
    // preHandler.
    resetConfigForTests();
    const emptyApp = await buildApp({
      config: { ...TEST_ENV_BASE, BACKOFFICE_SERVICE_TOKENS: '' },
    });
    try {
      const body = JSON.stringify({
        device_id: 'SN-E-FAILCLOSED',
        otp_proof: VALID_OTP,
        canvas_user_id: 70_500,
      });
      const ts = Math.floor(Date.now() / 1000);
      const sig = hmacSign(SVC_SECRET, ts, body);
      const r = await emptyApp.inject({
        method: 'POST',
        url: '/api/v1/access-decisions',
        headers: {
          'content-type': 'application/json',
          authorization: `HMAC ${SVC_NAME} ${ts} ${sig}`,
        },
        payload: body,
      });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toMatchObject({ code: 'deny.idp_untrusted' });
    } finally {
      await emptyApp.close();
      // Restore the cached config for any subsequent test in this file
      // that re-uses the primary `app` instance.
      resetConfigForTests();
    }
  });

  // ---------------------------------------------------------------------
  // triangulation — boundary validation on the body schema
  // ---------------------------------------------------------------------

  it('body validation: 400 when canvas_user_id is missing (envelope stays deny.idp_untrusted-free)', async () => {
    const body = JSON.stringify({
      device_id: 'SN-TRI-MISSING-CANVAS',
      otp_proof: VALID_OTP,
    });
    const r = await postSigned(app, '/api/v1/access-decisions', { body });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'validation_error' });
  });

  it('body validation: 400 when canvas_user_id is a string (envelope shape)', async () => {
    const body = JSON.stringify({
      device_id: 'SN-TRI-STR-CANVAS',
      otp_proof: VALID_OTP,
      canvas_user_id: '42',
    });
    const r = await postSigned(app, '/api/v1/access-decisions', { body });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'validation_error' });
  });

  it('body validation: 400 when device_id is missing', async () => {
    const body = JSON.stringify({
      otp_proof: VALID_OTP,
      canvas_user_id: 42,
    });
    const r = await postSigned(app, '/api/v1/access-decisions', { body });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'validation_error' });
  });

  it('parseServiceTokens round-trip on the registry used by the test env', () => {
    // Belt-and-suspenders: the integration suite signs requests with
    // SVC_NAME/SVC_SECRET, and the preHandler resolves the registry
    // via parseServiceTokens. If the parser starts splitting on `,`
    // differently, every auth-matrix test above would fail loudly —
    // this assert keeps the contract pinned at the test boundary.
    const map = parseServiceTokens({ BACKOFFICE_SERVICE_TOKENS: TEST_ENV.BACKOFFICE_SERVICE_TOKENS ?? '' });
    expect(map.get(SVC_NAME)).toBe(SVC_SECRET);
  });
});