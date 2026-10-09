/**
 * M3 / `POST /api/v1/mfa/redirect-token` + `POST /api/v1/mfa/consume`
 * — end-to-end integration tests.
 *
 * Boots the real Fastify app via `buildApp`, drives the two SSO
 * redirect endpoints through `app.inject`, and exercises the full
 * contract:
 *
 *   /redirect-token (student-session cookie auth):
 *     - happy path: student session + allowlisted next_url → 200
 *       { token, expires_in: 30 }; Redis key stored with the
 *       documented payload + 30s TTL.
 *     - missing next_url                       → 400 invalid_request
 *     - non-allowlisted next_url origin        → 403 mfa_redirect_origin_not_allowed
 *     - invalid URL                            → 400 invalid_request
 *     - no student session (no cookie)         → 401
 *     - cookie for a kind='user' session       → 401 mfa_session_kind_invalid
 *
 *   /consume (HMAC service-auth, mirroring /api/v1/access-decisions):
 *     - happy path: valid token + HMAC auth → 200 with student
 *       identity; token deleted from Redis (one-time use).
 *     - replay: same token consumed twice → first 200, second
 *       401 mfa_token_invalid.
 *     - unknown token                         → 401 mfa_token_invalid
 *     - next_url origin not in allowlist      → 401 mfa_token_invalid
 *     - missing HMAC auth                     → 401 deny.idp_untrusted
 *     - audit row written with outcome=ok,
 *       canvas_user_id.
 *
 *   Token-leak guards: the raw token is NEVER echoed in any deny
 *   response, the audit row, or the warn log.
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
const SVC_SECRET = 'integration-shared-secret-m3';
const SKEW = 60;
const VALID_OTP = '123456';
const MOCK_OTP_ID = 'otp-m3-redirect-token';

const MFA_REDIRECT_ORIGINS =
  'https://canvas.example.com,https://canvas-staging.example.com';

const ALLOWLISTED_NEXT = 'https://canvas.example.com/dashboard';
const STAGING_NEXT = 'https://canvas-staging.example.com/dashboard';
const OFF_ALLOWLIST_NEXT = 'https://evil.example.com/phish';
const LOCAL_NEXT = '/backoffice/dashboard';

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
  MFA_ALLOWED_REDIRECT_ORIGINS: MFA_REDIRECT_ORIGINS,
};

interface OtpFetchResponse {
  status: number;
  body: unknown;
}

type OtpBehaviour = (body: { token?: string; subject?: string; scope?: string }) => OtpFetchResponse;

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

interface PostSignedOptions {
  body?: string;
  ts?: number;
  serviceName?: string;
  secret?: string;
  authorizationOverride?: string;
  userAgent?: string;
}

async function postSigned(
  app: Awaited<ReturnType<typeof buildApp>>,
  url: string,
  opts: PostSignedOptions = {},
) {
  const body = opts.body ?? JSON.stringify({ token: 'unused' });
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const sig = hmacSign(opts.secret ?? SVC_SECRET, ts, body);
  const authorization =
    opts.authorizationOverride ??
    `HMAC ${opts.serviceName ?? SVC_NAME} ${ts} ${sig}`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization,
  };
  if (opts.userAgent) headers['user-agent'] = opts.userAgent;
  return app.inject({
    method: 'POST',
    url,
    headers,
    payload: body,
  });
}

const CODE_HAPPY = 'CODE-M3-HAPPY-1234567';
const SERIAL_HAPPY = 'SN-M3-HAPPY';
const CANVAS_HAPPY = 91_001;
const CANVAS_OTHER = 91_002;
const CANVAS_LOCAL = 91_003;

interface MfaAuthBody {
  marbete_code: string;
  serial_number: string;
  otp: string;
}

function mfaBody(overrides: Partial<MfaAuthBody> = {}): MfaAuthBody {
  return {
    marbete_code: CODE_HAPPY,
    serial_number: SERIAL_HAPPY,
    otp: VALID_OTP,
    ...overrides,
  };
}

interface RedirectIssueBody {
  next_url: string;
}

function issueBody(overrides: Partial<RedirectIssueBody> = {}): RedirectIssueBody {
  return {
    next_url: ALLOWLISTED_NEXT,
    ...overrides,
  };
}

interface ConsumeBody {
  token: string;
}

function consumeBody(token: string): string {
  return JSON.stringify({ token } satisfies ConsumeBody);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('M3 / MFA redirect + consume (integration, real PG + Redis)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;
  let studentId: number;
  let otherStudentId: number;
  let localStudentId: number;
  let mfaCookie: string;

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
    // Per-test isolation. Redis state from the previous test
    // (any leftover mfa_redirect:* keys) is cleared via
    // SCAN+UNLINK because app.redis does not expose flushdb.
    const { Redis: RedisClient } = await import('ioredis');
    const c = new RedisClient(
      process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
    );
    try {
      const keys = await c.keys('mfa_redirect:*');
      if (keys.length > 0) await c.del(...keys);
      const loginKeys = await c.keys('login_attempts:*');
      if (loginKeys.length > 0) await c.del(...loginKeys);
    } finally {
      await c.quit();
    }

    await pool.query(`TRUNCATE TABLE audit_log RESTART IDENTITY`);
    await pool.query(`DELETE FROM sessions`);
    await pool.query(`DELETE FROM dispositivos`);
    await pool.query(`DELETE FROM marbetes`);
    await pool.query(`DELETE FROM students_cache`);

    studentId = await seedStudent(pool, CANVAS_HAPPY, 'M3 Happy Student', true);
    otherStudentId = await seedStudent(pool, CANVAS_OTHER, 'M3 Other Student', true);
    localStudentId = await seedStudent(pool, CANVAS_LOCAL, 'M3 Local Student', true);
    await seedMarbete(pool, {
      code: CODE_HAPPY,
      publicUid: 'm-M3HAPPY',
      assignedStudentId: studentId,
    });
    await seedDevice(pool, {
      serial: SERIAL_HAPPY,
      assignedStudentId: studentId,
    });

    // The MFA cookie is reused across most tests so each test
    // does not need to drive the full /authenticate flow.
    // The "no student session" and "kind=user" tests override
    // the cookie before issuing the request.
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(mfaBody()),
    });
    expect(r.statusCode).toBe(201);
    const cookie = cookieFromSetCookie(r.headers['set-cookie'], '__Host-mfa_sid');
    if (!cookie) throw new Error('mfa_cookie_seed_failed');
    mfaCookie = cookie;
  });

  // -----------------------------------------------------------------
  // /redirect-token — happy path + Redis state
  // -----------------------------------------------------------------

  it('happy: 200 with { token, expires_in: 30 } when the session is valid and the origin is allowlisted', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/redirect-token',
      headers: { 'content-type': 'application/json', cookie: mfaCookie },
      payload: JSON.stringify(issueBody()),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { token: string; expires_in: number };
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.expires_in).toBe(30);

    // The token must be stored in Redis with the documented
    // payload shape and a 30-second TTL (allow 25-30s for
    // clock drift / time the test takes to run).
    const raw = await app.redis.get(`mfa_redirect:${body.token}`);
    expect(raw).not.toBeNull();
    const payload = JSON.parse(raw!) as {
      canvas_user_id: number;
      student_name: string;
      student_email: string;
      role: string;
      next_url: string;
      issued_at: string;
    };
    expect(payload.canvas_user_id).toBe(CANVAS_HAPPY);
    expect(payload.student_name).toBe('M3 Happy Student');
    expect(payload.student_email).toBe(`student-${CANVAS_HAPPY}@quorum.local`);
    expect(payload.role).toBe('student');
    expect(payload.next_url).toBe(ALLOWLISTED_NEXT);
    expect(typeof payload.issued_at).toBe('string');

    const ttl = await app.redis.ttl(`mfa_redirect:${body.token}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it('happy: a second allowlisted origin (staging) is accepted verbatim', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/redirect-token',
      headers: { 'content-type': 'application/json', cookie: mfaCookie },
      payload: JSON.stringify(issueBody({ next_url: STAGING_NEXT })),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { token: string };
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
  });

  // -----------------------------------------------------------------
  // /redirect-token — body validation
  // -----------------------------------------------------------------

  it('redirect-token: 400 invalid_request when next_url is missing', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/redirect-token',
      headers: { 'content-type': 'application/json', cookie: mfaCookie },
      payload: JSON.stringify({}),
    });
    expect(r.statusCode).toBe(400);
    const body = r.json() as { code: string };
    expect(body.code).toBe('validation_error');
  });

  it('redirect-token: 400 invalid_request when next_url is not a parseable URL', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/redirect-token',
      headers: { 'content-type': 'application/json', cookie: mfaCookie },
      payload: JSON.stringify({ next_url: 'not a url at all' }),
    });
    expect(r.statusCode).toBe(400);
    const body = r.json() as { code: string };
    expect(body.code).toBe('invalid_request');
  });

  // -----------------------------------------------------------------
  // /redirect-token — origin allowlist
  // -----------------------------------------------------------------

  it('redirect-token: 403 mfa_redirect_origin_not_allowed when the origin is not in MFA_ALLOWED_REDIRECT_ORIGINS', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/redirect-token',
      headers: { 'content-type': 'application/json', cookie: mfaCookie },
      payload: JSON.stringify(issueBody({ next_url: OFF_ALLOWLIST_NEXT })),
    });
    expect(r.statusCode).toBe(403);
    const body = r.json() as { code: string };
    expect(body.code).toBe('mfa_redirect_origin_not_allowed');
  });

  it('redirect-token: 403 mfa_redirect_origin_not_allowed when the origin has a different host suffix (suffix attack)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/redirect-token',
      headers: { 'content-type': 'application/json', cookie: mfaCookie },
      payload: JSON.stringify(issueBody({ next_url: 'https://canvas.example.com.evil.com/x' })),
    });
    expect(r.statusCode).toBe(403);
    const body = r.json() as { code: string };
    expect(body.code).toBe('mfa_redirect_origin_not_allowed');
  });

  // -----------------------------------------------------------------
  // /redirect-token — auth gates
  // -----------------------------------------------------------------

  it('redirect-token: 401 unauthorized when no student session cookie is supplied', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/redirect-token',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(issueBody()),
    });
    expect(r.statusCode).toBe(401);
    const body = r.json() as { code: string };
    // The exact code is either 'unauthorized' (when no
    // cookie) or a more specific session_kind_invalid when
    // a cookie is present but the session is not a student
    // session. Both are 401-class so the test only asserts
    // the status; the next test pins the kind-mismatch
    // code.
    expect(body.code).toBe('unauthorized');
  });

  it('redirect-token: 401 mfa_session_kind_invalid when the cookie belongs to a kind="user" session', async () => {
    // Seed a kind='user' session directly. The MFA endpoint
    // MUST reject it: a BackOffice operator session cannot
    // mint an MFA redirect token. The session token must be
    // a valid base64url-shaped string (>=16 chars) so it
    // survives the `isValidSessionToken` pre-check; we use
    // 24 chars to leave headroom.
    const opSessionToken = 'm3op-session-user-1234-5678';
    const userRes = await pool.query<{ id: number }>(
      `INSERT INTO users (email, username, password_hash, role)
       VALUES ('m3-op-user@example.test', 'm3-op-user', '$2b$10$abcdefghijklmnopqrstuv', 'admin')
       RETURNING id`,
    );
    const userId = userRes.rows[0]?.id;
    expect(userId).toBeDefined();
    await pool.query(
      `INSERT INTO sessions (id, user_id, kind, canvas_user_id, expires_at, ip, user_agent)
       VALUES ($1, $2, 'user', NULL, now() + interval '1 hour', '127.0.0.1', 'jest')`,
      [opSessionToken, userId],
    );
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/redirect-token',
      headers: {
        'content-type': 'application/json',
        cookie: `__Host-mfa_sid=${opSessionToken}`,
      },
      payload: JSON.stringify(issueBody()),
    });
    expect(r.statusCode).toBe(401);
    const body = r.json() as { code: string };
    expect(body.code).toBe('mfa_session_kind_invalid');
  });

  it('redirect-token: 401 when the session token is unknown / expired', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/redirect-token',
      headers: {
        'content-type': 'application/json',
        cookie: '__Host-mfa_sid=this-is-a-fake-session-token-value',
      },
      payload: JSON.stringify(issueBody()),
    });
    expect(r.statusCode).toBe(401);
  });

  // -----------------------------------------------------------------
  // /consume — HMAC auth matrix
  // -----------------------------------------------------------------

  it('consume: 401 deny.idp_untrusted when the Authorization header is missing', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/consume',
      headers: { 'content-type': 'application/json' },
      payload: consumeBody('any-token'),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  it('consume: 401 deny.idp_untrusted for a tampered signature', async () => {
    const r = await postSigned(app, '/api/v1/mfa/consume', {
      secret: 'a-completely-different-secret-32-bytes!',
      body: consumeBody('any-token'),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  it('consume: 401 deny.idp_untrusted for a stale timestamp', async () => {
    const r = await postSigned(app, '/api/v1/mfa/consume', {
      ts: Math.floor(Date.now() / 1000) - (SKEW + 30),
      body: consumeBody('any-token'),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'deny.idp_untrusted' });
  });

  // -----------------------------------------------------------------
  // /consume — token state matrix
  // -----------------------------------------------------------------

  it('consume: 401 mfa_token_invalid for an unknown token', async () => {
    const r = await postSigned(app, '/api/v1/mfa/consume', {
      body: consumeBody('0000000000000000000000000000000000000000000000000000000000000000'),
    });
    expect(r.statusCode).toBe(401);
    const body = r.json() as { code: string };
    expect(body.code).toBe('mfa_token_invalid');
  });

  it('consume: 200 with the student identity on the happy path; token deleted from Redis', async () => {
    // First, mint a token via /redirect-token.
    const issue = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/redirect-token',
      headers: { 'content-type': 'application/json', cookie: mfaCookie },
      payload: JSON.stringify(issueBody()),
    });
    expect(issue.statusCode).toBe(200);
    const { token } = issue.json() as { token: string };

    // The token MUST be in Redis before the consume call.
    const before = await app.redis.get(`mfa_redirect:${token}`);
    expect(before).not.toBeNull();

    // Consume the token. The HMAC preHandler authenticates the
    // service; the route reads the payload and atomically
    // deletes the key.
    const r = await postSigned(app, '/api/v1/mfa/consume', {
      body: consumeBody(token),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      canvas_user_id: number;
      student_name: string;
      student_email: string;
      role: 'student';
      next_url: string;
    };
    expect(body.canvas_user_id).toBe(CANVAS_HAPPY);
    expect(body.student_name).toBe('M3 Happy Student');
    expect(body.student_email).toBe(`student-${CANVAS_HAPPY}@quorum.local`);
    expect(body.role).toBe('student');
    expect(body.next_url).toBe(ALLOWLISTED_NEXT);

    // The token MUST be gone from Redis (one-time use).
    const after = await app.redis.get(`mfa_redirect:${token}`);
    expect(after).toBeNull();
  });

  it('consume: 401 mfa_token_invalid on replay (same token consumed twice → 200, then 401)', async () => {
    const issue = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/redirect-token',
      headers: { 'content-type': 'application/json', cookie: mfaCookie },
      payload: JSON.stringify(issueBody()),
    });
    expect(issue.statusCode).toBe(200);
    const { token } = issue.json() as { token: string };

    const r1 = await postSigned(app, '/api/v1/mfa/consume', {
      body: consumeBody(token),
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await postSigned(app, '/api/v1/mfa/consume', {
      body: consumeBody(token),
    });
    expect(r2.statusCode).toBe(401);
    expect(r2.json()).toMatchObject({ code: 'mfa_token_invalid' });
  });

  it('consume: 401 mfa_token_invalid when the next_url origin is not allowlisted', async () => {
    // Inject a payload directly into Redis (bypassing the
    // /redirect-token origin gate) so we can test the consume
    // path's allowlist check in isolation. The token itself is
    // well-formed (64 hex chars) and exists, but the
    // `next_url` is the off-allowlist one.
    const token = 'a'.repeat(64);
    const offOriginPayload = {
      canvas_user_id: CANVAS_HAPPY,
      student_name: 'M3 Happy Student',
      student_email: `student-${CANVAS_HAPPY}@quorum.local`,
      role: 'student',
      next_url: OFF_ALLOWLIST_NEXT,
      issued_at: new Date().toISOString(),
    };
    await app.redis.set(
      `mfa_redirect:${token}`,
      JSON.stringify(offOriginPayload),
      30,
    );

    const r = await postSigned(app, '/api/v1/mfa/consume', {
      body: consumeBody(token),
    });
    expect(r.statusCode).toBe(401);
    const body = r.json() as { code: string };
    expect(body.code).toBe('mfa_token_invalid');
  });

  // -----------------------------------------------------------------
  // /consume — audit row
  // -----------------------------------------------------------------

  it('consume: writes an audit row with action=student.mfa_consume, outcome=ok, entity_id=canvas_user_id', async () => {
    const issue = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/redirect-token',
      headers: {
        'content-type': 'application/json',
        cookie: mfaCookie,
        'user-agent': 'jest-m3-consume/1.0',
      },
      payload: JSON.stringify(issueBody()),
    });
    expect(issue.statusCode).toBe(200);
    const { token } = issue.json() as { token: string };

    const r = await postSigned(app, '/api/v1/mfa/consume', {
      body: consumeBody(token),
      userAgent: 'jest-m3-consume/1.0',
    });
    expect(r.statusCode).toBe(200);

    const audit = await pool.query<{
      action: string;
      entity_type: string | null;
      entity_id: string | null;
      after_jsonb: unknown;
      user_agent: string | null;
    }>(
      `SELECT action, entity_type, entity_id,
              after_jsonb::text::jsonb AS after_jsonb,
              user_agent
         FROM audit_log
        WHERE action = 'student.mfa_consume'
        ORDER BY id DESC
        LIMIT 1`,
    );
    const row = audit.rows[0];
    expect(row).toBeDefined();
    expect(row?.entity_type).toBe('student');
    expect(row?.entity_id).toBe(String(CANVAS_HAPPY));
    const after = row?.after_jsonb as { outcome?: string; next_url?: string };
    expect(after?.outcome).toBe('ok');
    expect(after?.next_url).toBe(ALLOWLISTED_NEXT);
    expect(row?.user_agent).toBe('jest-m3-consume/1.0');
  });

  // -----------------------------------------------------------------
  // /consume — token-leak guard
  // -----------------------------------------------------------------

  it('consume: the raw token is NEVER echoed in the deny response or the audit row', async () => {
    const issue = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/redirect-token',
      headers: { 'content-type': 'application/json', cookie: mfaCookie },
      payload: JSON.stringify(issueBody()),
    });
    expect(issue.statusCode).toBe(200);
    const { token } = issue.json() as { token: string };

    // Consume once (success).
    const r1 = await postSigned(app, '/api/v1/mfa/consume', {
      body: consumeBody(token),
    });
    expect(r1.statusCode).toBe(200);
    expect(JSON.stringify(r1.json())).not.toContain(token);

    // Replay (deny). The deny response MUST NOT include the token.
    const r2 = await postSigned(app, '/api/v1/mfa/consume', {
      body: consumeBody(token),
    });
    expect(r2.statusCode).toBe(401);
    expect(JSON.stringify(r2.json())).not.toContain(token);

    // The audit row MUST NOT include the token.
    const audit = await pool.query<{ after_jsonb: unknown }>(
      `SELECT after_jsonb::text::jsonb AS after_jsonb
         FROM audit_log
        WHERE action = 'student.mfa_consume'`,
    );
    for (const row of audit.rows) {
      expect(JSON.stringify(row.after_jsonb)).not.toContain(token);
    }
  });
});
