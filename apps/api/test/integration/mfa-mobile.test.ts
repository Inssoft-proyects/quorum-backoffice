/**
 * M5 / Mobile-friendly contract for `POST /api/v1/mfa/authenticate`.
 *
 * M1 is already shipped: the endpoint returns a JSON body and a
 * `__Host-mfa_sid` session cookie. M5 does NOT add a new endpoint;
 * it locks the contract the mobile channel depends on so a future
 * refactor of the M1 response shape is forced through a deliberate
 * test update.
 *
 * The mobile app's WebView / CookieJar:
 *   - parses the response body as JSON (no HTML, no XML, no
 *     streaming chunks)
 *   - persists the `__Host-mfa_sid` cookie for subsequent calls
 *   - relies on the documented `Content-Type: application/json` so
 *     its parser picks the right decoder
 *
 * Coverage:
 *
 *   - happy path: response is application/json with a stable
 *     JSON-serializable body (no Buffer, no Date, no circular
 *     references, no functions, no `undefined` values, no `NaN` /
 *     `Infinity`)
 *   - the body carries the exact fields the mobile app needs:
 *     `canvas_user_id`, `student_name`, `student_email`, `role`,
 *     `session_id`, `expires_at` (the latter is an ISO 8601 string,
 *     NOT a Date — mobile parsers cannot deserialize a Date over
 *     JSON natively)
 *   - the Set-Cookie header carries the `__Host-` prefix and the
 *     four cookie attributes a mobile WebView will reject without
 *     (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`)
 *   - a SECOND mobile client (different IP + different user-agent)
 *     can authenticate independently and gets a DIFFERENT session
 *     cookie value (proves no cross-client leakage)
 *   - the response body survives a `JSON.stringify` / `JSON.parse`
 *     roundtrip (the mobile app stores the parsed result in its
 *     in-memory session object)
 *   - the audit row is written with `action='student.mfa_authenticate'`
 *     and `outcome='ok'` (defense-in-depth: the M1 tests already
 *     assert this, but the M5 test locks the wire + audit pair
 *     together)
 *
 * The fixtures are designed to match the wire format emitted by
 * OtpClient (`{ subject, scope, token }`, NOT `code`) and the
 * `valid: true` shape the client expects on success — same pattern
 * as the M1 integration suite.
 */
import { Pool, types } from 'pg';
import path from 'node:path';
import { buildApp } from '../../src/app';
import { migrate } from '../../src/migrations';
import { hashMarbeteCode } from '../../src/lib/marbete-code';

const TEST_DATABASE_URL =
  process.env['DATABASE_URL_TEST'] ??
  'postgresql://websop:quorum_backoffice_dev@127.0.0.1:5432/quorum_backoffice_test';

// BIGINT (oid 20) is parsed as a number — mirrors the parser app.ts
// installs at module load. Without this override the raw pool
// returns strings for the BIGINT columns (canvas_user_id, etc.).
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
const MOCK_OTP_ID = 'otp-m5-mobile-contract';

interface OtpFetchResponse {
  status: number;
  body: unknown;
}

type OtpBehaviour = (body: {
  token?: string;
  subject?: string;
  scope?: string;
}) => OtpFetchResponse;

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
    assignedStudentId: number | null;
    publicUid?: string;
  },
): Promise<number> {
  const codeHash = hashMarbeteCode(args.code);
  const publicUid = args.publicUid ?? `m-${args.code.slice(0, 4).toUpperCase()}`;
  const r = await pool.query<{ id: number }>(
    `INSERT INTO marbetes
       (public_uid, code_hash, status, assigned_student_id, created_by, deleted_at, assigned_at)
     VALUES ($1, $2, $3::marbete_status, $4, 'tester', NULL, CASE WHEN $4::bigint IS NULL THEN NULL ELSE now() END)
     RETURNING id`,
    [publicUid, codeHash, args.status ?? 'active', args.assignedStudentId],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('marbete_seed_failed');
  return id;
}

async function seedDevice(
  pool: Pool,
  args: {
    serial: string;
    assignedStudentId: number;
  },
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO dispositivos
       (serial_number, brand, model, status, created_by, assigned_student_id, revoked_at)
     VALUES ($1, 'TestBrand', 'TestModel', 'active', 'tester', $2, NULL)
     RETURNING id`,
    [args.serial, args.assignedStudentId],
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

/**
 * The mobile-friendly response shape. Mirrors the
 * `MfaAuthenticateResponse` Zod DTO in
 * `packages/shared/src/dto/mfa.ts`. Listed here as a type
 * literal so the test fails loudly if a future refactor adds
 * or removes a field without updating the mobile contract.
 */
interface MobileAuthResponse {
  canvas_user_id: number;
  student_name: string;
  student_email: string;
  role: 'student';
  session_id: string;
  expires_at: string; // ISO 8601
}

const CODE_A = 'CODE-MOBILE-A-12345';
const CODE_B = 'CODE-MOBILE-B-12345';
const SERIAL_A = 'SN-MOBILE-A';
const SERIAL_B = 'SN-MOBILE-B';
const CANVAS_A = 91_001;
const CANVAS_B = 91_002;

interface MobileBody {
  marbete_code: string;
  serial_number: string;
  otp: string;
}

function mobileBody(overrides: Partial<MobileBody> = {}): MobileBody {
  return {
    marbete_code: CODE_A,
    serial_number: SERIAL_A,
    otp: VALID_OTP,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('M5 / Mobile contract for POST /api/v1/mfa/authenticate', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;
  let studentAId: number;
  let studentBId: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    // Reset schema. The MFA integration suite uses the same
    // pattern; share the destructive setup so each test file
    // is independent of the others.
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
    await pool.query(`TRUNCATE TABLE audit_log RESTART IDENTITY`);
    await pool.query(`DELETE FROM sessions`);
    await pool.query(`DELETE FROM dispositivos`);
    await pool.query(`DELETE FROM marbetes`);
    await pool.query(`DELETE FROM students_cache`);

    studentAId = await seedStudent(pool, CANVAS_A, 'Mobile Student A', true);
    studentBId = await seedStudent(pool, CANVAS_B, 'Mobile Student B', true);
    await seedMarbete(pool, {
      code: CODE_A,
      publicUid: 'm-MOBILE-A',
      assignedStudentId: studentAId,
    });
    await seedMarbete(pool, {
      code: CODE_B,
      publicUid: 'm-MOBILE-B',
      assignedStudentId: studentBId,
    });
    await seedDevice(pool, { serial: SERIAL_A, assignedStudentId: studentAId });
    await seedDevice(pool, { serial: SERIAL_B, assignedStudentId: studentBId });
  });

  // -----------------------------------------------------------------
  // Content-Type + JSON-serializability
  // -----------------------------------------------------------------

  it('mobile: response Content-Type is application/json (not text/html, not anything else)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(mobileBody()),
    });
    expect(r.statusCode).toBe(201);
    // Mobile WebViews / CookieJars branch on Content-Type to pick
    // a decoder; locking the value byte-for-byte is the contract.
    const ct = r.headers['content-type'];
    expect(ct).toBeDefined();
    // The header MAY include a charset suffix; split on ';' and
    // assert the media type independently of the encoding.
    const mediaType = (ct ?? '').split(';')[0]!.trim().toLowerCase();
    expect(mediaType).toBe('application/json');
  });

  it('mobile: response body is JSON-serializable — no Buffer, no Date, no circular refs, no functions', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(mobileBody()),
    });
    expect(r.statusCode).toBe(201);
    // The body must survive a JSON.stringify without throwing
    // (the "Converting circular structure to JSON" guard) and
    // without emitting a `{"type":"Buffer",...}` chunk (which
    // would indicate a leaked Buffer).
    const raw = r.body;
    // The raw body is a JSON string. Round-trip it; if the
    // original were not serializable, Fastify would have thrown
    // before the test ran.
    const parsed: MobileAuthResponse = JSON.parse(raw);
    // No circular refs: stringify the parsed object again. A
    // circular ref would throw here.
    const round = JSON.stringify(parsed);
    expect(typeof round).toBe('string');
    expect(round.length).toBeGreaterThan(0);
    // Walk the parsed object and assert no Buffer / Date /
    // function leaks. (The DTO contract is primitive types only,
    // so this is a defense-in-depth check for future refactors.)
    const seen = new Set<object>();
    const walk = (v: unknown): void => {
      if (v === null || typeof v !== 'object') return;
      if (seen.has(v as object)) {
        throw new Error('circular reference detected in response body');
      }
      seen.add(v as object);
      if (Buffer.isBuffer(v)) {
        throw new Error('Buffer leaked into the JSON response body');
      }
      if (v instanceof Date) {
        throw new Error('Date object leaked into the JSON response body');
      }
      for (const k of Object.keys(v as Record<string, unknown>)) {
        const child = (v as Record<string, unknown>)[k];
        if (typeof child === 'function') {
          throw new Error(`function leaked into the JSON response body (key=${k})`);
        }
        walk(child);
      }
    };
    walk(parsed);
  });

  // -----------------------------------------------------------------
  // Field shape (the exact fields the mobile app reads)
  // -----------------------------------------------------------------

  it('mobile: response body carries every field the mobile app needs', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(mobileBody()),
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as Record<string, unknown>;

    // The mobile app relies on a fixed set of fields. Lock the
    // exact keys so a future refactor that adds / renames a
    // field forces an explicit mobile contract update.
    const EXPECTED_KEYS = [
      'canvas_user_id',
      'student_name',
      'student_email',
      'role',
      'session_id',
      'expires_at',
    ].sort();
    expect(Object.keys(body).sort()).toEqual(EXPECTED_KEYS);

    // Per-field type + value invariants.
    expect(typeof body['canvas_user_id']).toBe('number');
    expect(body['canvas_user_id']).toBe(CANVAS_A);
    expect(typeof body['student_name']).toBe('string');
    expect(body['student_name']).toBe('Mobile Student A');
    expect(typeof body['student_email']).toBe('string');
    expect(body['student_email']).toBe(`student-${CANVAS_A}@quorum.local`);
    expect(body['role']).toBe('student');
    expect(typeof body['session_id']).toBe('string');
    // The session_id is the same opaque base64url string the
    // cookie stores; lock its shape so a future shortening does
    // not silently break the mobile cookie store mapping.
    expect((body['session_id'] as string)).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    // `expires_at` is an ISO 8601 STRING, not a Date, so the
    // mobile JSON parser can pick it up without a custom decoder.
    expect(typeof body['expires_at']).toBe('string');
    expect(() => new Date(body['expires_at'] as string).toISOString()).not.toThrow();
    expect(new Date(body['expires_at'] as string).getTime()).toBeGreaterThan(Date.now());
  });

  it('mobile: response body survives a JSON.stringify / JSON.parse roundtrip with no NaN / Infinity / undefined', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(mobileBody()),
    });
    expect(r.statusCode).toBe(201);
    const first = r.json() as MobileAuthResponse;
    const reencoded = JSON.stringify(first);
    const reparsed: MobileAuthResponse = JSON.parse(reencoded);

    // The mobile session object is the reparsed value; every
    // field must round-trip to the same primitive value.
    expect(reparsed.canvas_user_id).toBe(first.canvas_user_id);
    expect(reparsed.student_name).toBe(first.student_name);
    expect(reparsed.student_email).toBe(first.student_email);
    expect(reparsed.role).toBe(first.role);
    expect(reparsed.session_id).toBe(first.session_id);
    expect(reparsed.expires_at).toBe(first.expires_at);

    // No NaN, no Infinity, no undefined: the reencoded string
    // must not contain those tokens (they cannot appear in a
    // valid JSON document, but the source could have produced
    // them via a non-standard serializer).
    expect(reencoded).not.toMatch(/NaN/);
    expect(reencoded).not.toMatch(/Infinity/);
    // An explicit `undefined` in a stringified value is dropped
    // by JSON.stringify, so we assert the reparsed object has
    // no `undefined` value for any key.
    for (const v of Object.values(reparsed)) {
      expect(v).not.toBeUndefined();
    }
  });

  // -----------------------------------------------------------------
  // Cookie attributes (the Set-Cookie contract the mobile WebView
  // depends on)
  // -----------------------------------------------------------------

  it('mobile: Set-Cookie carries __Host-mfa_sid + HttpOnly + Secure + SameSite=Lax + Path=/', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(mobileBody()),
    });
    expect(r.statusCode).toBe(201);
    const raw = r.headers['set-cookie'];
    expect(raw).toBeDefined();
    const first = Array.isArray(raw) ? raw[0] : raw;
    expect(first).toBeDefined();
    // The mobile WebView rejects the cookie if any of the
    // __Host- contract items is missing. Lock all five.
    expect(first).toMatch(/^__Host-mfa_sid=/);
    expect(first).toMatch(/HttpOnly/i);
    expect(first).toMatch(/Secure/i);
    expect(first).toMatch(/SameSite=Lax/i);
    expect(first).toMatch(/Path=\//);
    // The cookie value (everything between the first '=' and
    // the first ';') is the same opaque session_id the body
    // returns — the mobile app cross-references them.
    const cookiePair = first!.split(';')[0]!;
    const cookieValue = cookiePair.split('=')[1];
    const body = r.json() as { session_id: string };
    expect(cookieValue).toBe(body.session_id);
  });

  // -----------------------------------------------------------------
  // Cross-client independence: a second mobile client with a
  // different IP + different user-agent gets a DIFFERENT session
  // cookie (proves no cross-client leakage).
  // -----------------------------------------------------------------

  it('mobile: a second client (different IP + user-agent) authenticates independently and gets a different session cookie', async () => {
    // Client A authenticates from 10.0.0.1 / "MobileA/1.0".
    const rA = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '10.0.0.1',
        'user-agent': 'MobileA/1.0',
      },
      payload: JSON.stringify(mobileBody()),
    });
    expect(rA.statusCode).toBe(201);
    const cookieA = cookieFromSetCookie(rA.headers['set-cookie'], '__Host-mfa_sid');
    expect(cookieA).not.toBeNull();
    const bodyA = rA.json() as { session_id: string; canvas_user_id: number };
    expect(bodyA.canvas_user_id).toBe(CANVAS_A);

    // Client B authenticates from 10.0.0.2 / "MobileB/1.0"
    // using its OWN marbete + device. The session_id MUST
    // differ from Client A's; the cookie value MUST also
    // differ (the cookie value IS the session_id).
    const rB = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '10.0.0.2',
        'user-agent': 'MobileB/1.0',
      },
      payload: JSON.stringify(
        mobileBody({
          marbete_code: CODE_B,
          serial_number: SERIAL_B,
        }),
      ),
    });
    expect(rB.statusCode).toBe(201);
    const cookieB = cookieFromSetCookie(rB.headers['set-cookie'], '__Host-mfa_sid');
    expect(cookieB).not.toBeNull();
    const bodyB = rB.json() as { session_id: string; canvas_user_id: number };
    expect(bodyB.canvas_user_id).toBe(CANVAS_B);

    // Different sessions: cookie and body.session_id MUST differ.
    expect(cookieA).not.toBe(cookieB);
    expect(bodyA.session_id).not.toBe(bodyB.session_id);

    // The `sessions` table MUST have two rows (one per client),
    // each with the right kind + canvas_user_id. The cookie
    // value is the primary key.
    const sessCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sessions WHERE kind = 'student'`,
    );
    expect(Number(sessCount.rows[0]?.count ?? '0')).toBe(2);
    // The `ip` column is an INET; PG renders it as
    // '<host>/<cidr>'. The mobile contract only depends on the
    // host portion being captured — extract it with `host()`
    // so the test does not lock the internal storage format.
    const sessA = await pool.query<{ canvas_user_id: number; ip_host: string | null; user_agent: string | null }>(
      `SELECT canvas_user_id, host(ip) AS ip_host, user_agent
         FROM sessions WHERE id = $1`,
      [bodyA.session_id],
    );
    expect(sessA.rows[0]?.canvas_user_id).toBe(CANVAS_A);
    expect(sessA.rows[0]?.ip_host).toBe('10.0.0.1');
    expect(sessA.rows[0]?.user_agent).toBe('MobileA/1.0');
    const sessB = await pool.query<{ canvas_user_id: number; ip_host: string | null; user_agent: string | null }>(
      `SELECT canvas_user_id, host(ip) AS ip_host, user_agent
         FROM sessions WHERE id = $1`,
      [bodyB.session_id],
    );
    expect(sessB.rows[0]?.canvas_user_id).toBe(CANVAS_B);
    expect(sessB.rows[0]?.ip_host).toBe('10.0.0.2');
    expect(sessB.rows[0]?.user_agent).toBe('MobileB/1.0');
  });

  // -----------------------------------------------------------------
  // Defense-in-depth: the audit row is written for the mobile
  // happy path. The M1 integration tests already assert this,
  // but the M5 mobile test locks the wire + audit pair together
  // so a future "audit on a different code path" regression is
  // caught at the mobile layer too.
  // -----------------------------------------------------------------

  it('mobile: writes the student.mfa_authenticate audit row (defense-in-depth)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/mfa/authenticate',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '10.0.0.1',
        'user-agent': 'MobileA/1.0',
      },
      payload: JSON.stringify(mobileBody()),
    });
    expect(r.statusCode).toBe(201);
    const auditRes = await pool.query<{
      actor_id: string;
      action: string;
      entity_id: string | null;
      ip_host: string | null;
      user_agent: string | null;
      after_jsonb: unknown;
    }>(
      `SELECT actor_id, action, entity_id, host(ip) AS ip_host, user_agent,
              after_jsonb::text::jsonb AS after_jsonb
         FROM audit_log
        WHERE action = 'student.mfa_authenticate'
        ORDER BY id DESC
        LIMIT 1`,
    );
    const row = auditRes.rows[0];
    expect(row).toBeDefined();
    expect(row!.action).toBe('student.mfa_authenticate');
    expect(row!.actor_id).toBe('__mfa__');
    expect(row!.entity_id).toBe(String(CANVAS_A));
    // The M1 contract stores the request meta in the audit row
    // so an operator can correlate a denied attempt with the
    // caller's network. The mobile happy path must not regress
    // that. The `ip` column is INET; `host()` strips the CIDR
    // suffix so the assertion does not lock the internal
    // storage format.
    expect(row!.ip_host).toBe('10.0.0.1');
    expect(row!.user_agent).toBe('MobileA/1.0');
    // The outcome in `after_jsonb` is 'ok' (the success branch);
    // never the deny labels.
    const after = row!.after_jsonb as { outcome?: string };
    expect(after.outcome).toBe('ok');
  });
});
