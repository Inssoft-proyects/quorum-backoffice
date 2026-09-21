/**
 * WU6b integration tests: session hydration + RBAC preHandlers.
 *
 * Coverage:
 *  - operator role: GET marbetes/dispositivos OK, POST/PATCH/DELETE 403
 *  - admin role: full access (OTP still required for writes)
 *  - auditor role: GET audit OK, GET marbetes OK, POST/PATCH/DELETE 403
 *  - no session: 401 on protected routes
 *  - expired session: 401
 *  - login: no session required, sets cookie
 *
 * Auth happens via the real POST /auth/login flow (no x-test-actor shim).
 */
import { Pool } from 'pg';
import path from 'node:path';
import bcrypt from 'bcrypt';
import { buildApp } from '../../src/app';
import { migrate } from '../../src/migrations';

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
  CANVAS_PORTAL_API_URL: 'http://127.0.0.1:65535',
  CANVAS_PORTAL_API_TOKEN: 'test-canvas-token-1234567890',
  SESSION_SECRET: 'a'.repeat(64),
  SESSION_TTL_SECONDS: '3600',
  AUTH_COOKIE_NAME: 'sid',
  AUTH_COOKIE_SECURE: 'false',
  AUTH_LOGIN_MAX_ATTEMPTS: '5',
  AUTH_LOGIN_WINDOW_SECONDS: '900',
};

const BCRYPT_COST = 10;
const VALID_OTP = '123456';

interface UserFixture {
  id: number;
  email: string;
  password: string;
  role: 'admin' | 'operator' | 'auditor';
}

async function seedUser(pool: Pool, email: string, password: string, role: UserFixture['role']): Promise<UserFixture> {
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  const r = await pool.query<{ id: number }>(
    `INSERT INTO users (email, password_hash, role) VALUES (lower($1), $2, $3) RETURNING id`,
    [email, hash, role],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('user_seed_failed');
  return { id, email, password, role };
}

function cookieFromSetCookie(setCookie: string | string[] | undefined, name: string): string | null {
  if (!setCookie) return null;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of arr) {
    const pair = c.split(';')[0];
    if (pair && pair.startsWith(`${name}=`)) return pair;
  }
  return null;
}

function makeOtpFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/otps/verify')) {
      return new Response(JSON.stringify({ id: 'otp-rbac-test' }), { status: 200 });
    }
    return new Response('not used', { status: 404 });
  }) as unknown as typeof fetch;
}

async function loginAndGetCookie(app: Awaited<ReturnType<typeof buildApp>>, email: string, password: string): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password }),
  });
  if (r.statusCode !== 200) throw new Error(`login_failed status=${r.statusCode} body=${r.body}`);
  const cookie = cookieFromSetCookie(r.headers['set-cookie'], 'sid');
  if (!cookie) throw new Error('no_cookie');
  return cookie;
}

describe('RBAC (integration, real PG + Redis)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;
  let admin: UserFixture;
  let operator: UserFixture;
  let auditor: UserFixture;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    await pool.query(`
      DROP TABLE IF EXISTS sessions CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
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

    admin = await seedUser(pool, `rbac-admin-${Date.now()}@example.test`, 'Adm1n!Pass', 'admin');
    operator = await seedUser(pool, `rbac-operator-${Date.now()}@example.test`, 'Op3r@Pass', 'operator');
    auditor = await seedUser(pool, `rbac-auditor-${Date.now()}@example.test`, 'Aud1t0rPass', 'auditor');

    app = await buildApp({ config: TEST_ENV });
    (globalThis as { fetch: typeof fetch }).fetch = makeOtpFetch();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('operator role', () => {
    let operatorCookie: string;

    beforeAll(async () => {
      operatorCookie = await loginAndGetCookie(app, operator.email, operator.password);
    });

    it('GET /api/v1/marbetes returns 200 (read access)', async () => {
      const r = await app.inject({
        method: 'GET',
        url: '/api/v1/marbetes',
        headers: { cookie: operatorCookie },
      });
      expect(r.statusCode).toBe(200);
    });

    it('POST /api/v1/marbetes returns 403 (write not allowed)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/marbetes',
        headers: {
          cookie: operatorCookie,
          'x-otp-code': VALID_OTP,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ code: 'OPERATOR-NO-OTP' }),
      });
      expect(r.statusCode).toBe(403);
    });

    it('POST /api/v1/dispositivos returns 403', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/dispositivos',
        headers: {
          cookie: operatorCookie,
          'x-otp-code': VALID_OTP,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ serialNumber: 'OP-NO-OTP-1' }),
      });
      expect(r.statusCode).toBe(403);
    });

    it('GET /api/v1/audit returns 403 (operator cannot read audit)', async () => {
      const r = await app.inject({
        method: 'GET',
        url: '/api/v1/audit',
        headers: { cookie: operatorCookie },
      });
      expect(r.statusCode).toBe(403);
    });
  });

  describe('auditor role', () => {
    let auditorCookie: string;

    beforeAll(async () => {
      auditorCookie = await loginAndGetCookie(app, auditor.email, auditor.password);
    });

    it('GET /api/v1/audit returns 200', async () => {
      const r = await app.inject({
        method: 'GET',
        url: '/api/v1/audit',
        headers: { cookie: auditorCookie },
      });
      expect(r.statusCode).toBe(200);
    });

    it('GET /api/v1/marbetes returns 200 (read access)', async () => {
      const r = await app.inject({
        method: 'GET',
        url: '/api/v1/marbetes',
        headers: { cookie: auditorCookie },
      });
      expect(r.statusCode).toBe(200);
    });

    it('POST /api/v1/marbetes returns 403 (no write)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/marbetes',
        headers: {
          cookie: auditorCookie,
          'x-otp-code': VALID_OTP,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ code: 'AUDITOR-NO-OTP' }),
      });
      expect(r.statusCode).toBe(403);
    });
  });

  describe('admin role', () => {
    let adminCookie: string;

    beforeAll(async () => {
      adminCookie = await loginAndGetCookie(app, admin.email, admin.password);
    });

    it('POST /api/v1/marbetes with valid OTP returns 201', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/marbetes',
        headers: {
          cookie: adminCookie,
          'x-otp-code': VALID_OTP,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ code: 'ADMIN-RBAC-MARBETE' }),
      });
      expect(r.statusCode).toBe(201);
    });

    it('POST /api/v1/marbetes without OTP returns 401 (OTP still required)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/marbetes',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        payload: JSON.stringify({ code: 'ADMIN-NO-OTP' }),
      });
      expect(r.statusCode).toBe(401);
    });

    it('GET /api/v1/audit returns 200', async () => {
      const r = await app.inject({
        method: 'GET',
        url: '/api/v1/audit',
        headers: { cookie: adminCookie },
      });
      expect(r.statusCode).toBe(200);
    });
  });

  describe('unauthenticated', () => {
    it('GET /api/v1/marbetes without cookie returns 401', async () => {
      const r = await app.inject({
        method: 'GET',
        url: '/api/v1/marbetes',
      });
      expect(r.statusCode).toBe(401);
    });

    it('POST /api/v1/marbetes without cookie returns 401', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/marbetes',
        headers: { 'x-otp-code': VALID_OTP, 'content-type': 'application/json' },
        payload: JSON.stringify({ code: 'NO-COOKIE' }),
      });
      expect(r.statusCode).toBe(401);
    });

    it('GET /api/v1/audit without cookie returns 401', async () => {
      const r = await app.inject({
        method: 'GET',
        url: '/api/v1/audit',
      });
      expect(r.statusCode).toBe(401);
    });
  });

  describe('expired session', () => {
    it('GET /api/v1/marbetes with expired session returns 401', async () => {
      // Create a session that has already expired.
      const pastExpiry = new Date(Date.now() - 60 * 60 * 1000);
      const r = await pool.query<{ id: string }>(
        `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent)
         VALUES ($1, $2, $3, NULL, NULL)
         RETURNING id`,
        ['expired-token-' + Date.now(), operator.id, pastExpiry],
      );
      const token = r.rows[0]?.id;
      if (!token) throw new Error('session_seed_failed');

      const resp = await app.inject({
        method: 'GET',
        url: '/api/v1/marbetes',
        headers: { cookie: `sid=${token}` },
      });
      expect(resp.statusCode).toBe(401);
    });
  });

  describe('x-test-actor shim (back-compat for tests)', () => {
    it('GET /api/v1/marbetes with x-test-actor returns 200 (treated as admin)', async () => {
      const r = await app.inject({
        method: 'GET',
        url: '/api/v1/marbetes',
        headers: { 'x-test-actor': 'shim-tester' },
      });
      expect(r.statusCode).toBe(200);
    });

    it('POST /api/v1/marbetes with x-test-actor + OTP returns 201 (treated as admin)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/marbetes',
        headers: {
          'x-test-actor': 'shim-tester',
          'x-otp-code': VALID_OTP,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ code: 'SHIM-CAN-WRITE' }),
      });
      expect(r.statusCode).toBe(201);
    });
  });
});