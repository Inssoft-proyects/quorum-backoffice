/**
 * WU6a integration tests: auth core (login, logout, me) + audit emissions
 * + rate limiting + disabled user handling.
 *
 * Coverage:
 *  - POST /api/v1/auth/login OK with valid credentials → 200 + Set-Cookie
 *  - POST /api/v1/auth/login wrong password → 401 + audit `auth.failed`
 *  - POST /api/v1/auth/login missing email/password → 400
 *  - POST /api/v1/auth/login disabled user → 403
 *  - POST /api/v1/auth/login 6th attempt rate-limited → 429
 *  - POST /api/v1/auth/login emits audit `auth.login` on success
 *  - POST /api/v1/auth/logout with valid session → 200 + audit `auth.logout`
 *  - POST /api/v1/auth/logout without session → 401
 *  - GET /api/v1/auth/me with valid session → 200 + user info
 *  - GET /api/v1/auth/me without session → 401
 *
 * Users are seeded directly via SQL with bcrypt-hashed passwords.
 * Rate-limit tests use unique emails per test so they don't interfere.
 */
import { Pool } from 'pg';
import path from 'node:path';
import bcrypt from 'bcrypt';
import { buildApp } from '../../src/app';
import { hashPassword } from '../../src/lib/password';
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

const BCRYPT_COST = 10; // lower than production (12) to keep tests fast

interface SeedUser {
  email: string;
  password: string;
  role: 'admin' | 'operator' | 'auditor';
  disabled?: boolean;
}

async function seedUser(pool: Pool, u: SeedUser): Promise<number> {
  const hash = await bcrypt.hash(u.password, BCRYPT_COST);
  const r = await pool.query<{ id: number }>(
    `INSERT INTO users (email, password_hash, role, disabled_at)
     VALUES (lower($1), $2, $3, ${u.disabled ? 'now()' : 'NULL'})
     RETURNING id`,
    [u.email, hash, u.role],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('user_seed_failed');
  return id;
}

/**
 * Extract the cookie value (e.g. "sid=abc...") from a Set-Cookie header.
 * The header value is the full Set-Cookie string; we want name=value.
 */
function cookieFromSetCookie(setCookie: string | string[] | undefined, name: string): string | null {
  if (!setCookie) return null;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of arr) {
    const pair = c.split(';')[0];
    if (pair && pair.startsWith(`${name}=`)) return pair;
  }
  return null;
}

describe('auth routes (integration, real PG + Redis)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;
  let seededAdminId: number;
  let _seededOperatorId: number;
  const adminEmail = 'admin@example.test';
  const adminPass = 'Adm1n!Pass';
  const operatorEmail = 'operator@example.test';
  const operatorPass = 'Op3r@torPass';

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

    seededAdminId = await seedUser(pool, { email: adminEmail, password: adminPass, role: 'admin' });
    _seededOperatorId = await seedUser(pool, { email: operatorEmail, password: operatorPass, role: 'operator' });

    app = await buildApp({ config: TEST_ENV });
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('not used', { status: 404 })) as unknown as typeof fetch;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('POST /api/v1/auth/login', () => {
    it('returns 200 + Set-Cookie on valid credentials and emits audit auth.login', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: adminEmail, password: adminPass }),
      });
      expect(r.statusCode).toBe(200);
      const cookie = cookieFromSetCookie(r.headers['set-cookie'], 'sid');
      expect(cookie).not.toBeNull();
      expect(cookie).toMatch(/^sid=[A-Za-z0-9_-]+$/);
      const body = r.json() as { user: { id: number; email: string; role: string } };
      expect(body.user.id).toBe(seededAdminId);
      expect(body.user.email).toBe(adminEmail);
      expect(body.user.role).toBe('admin');

      const audit = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_log
          WHERE action = 'auth.login' AND actor_id = $1`,
        [adminEmail],
      );
      expect(Number(audit.rows[0]?.count)).toBeGreaterThanOrEqual(1);
    });

    it('returns 401 on wrong password and emits audit auth.failed', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: adminEmail, password: 'wrong-pass-1234' }),
      });
      expect(r.statusCode).toBe(401);
      const body = r.json() as { code: string };
      expect(body.code).toBe('invalid_credentials');

      const audit = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_log
          WHERE action = 'auth.failed' AND actor_id = $1`,
        [adminEmail],
      );
      expect(Number(audit.rows[0]?.count)).toBeGreaterThanOrEqual(1);
    });

    it('returns 400 when email is missing', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ password: 'whatever' }),
      });
      expect(r.statusCode).toBe(400);
    });

    it('returns 400 when password is missing', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: 'whatever@x.test' }),
      });
      expect(r.statusCode).toBe(400);
    });

    it('returns 401 for unknown user (no user enumeration)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: `unknown-user-${Date.now()}@example.test`, password: 'whatever' }),
      });
      expect(r.statusCode).toBe(401);
    });

    it('returns 403 when user is disabled', async () => {
      const disabledEmail = `disabled-${Date.now()}@example.test`;
      await seedUser(pool, { email: disabledEmail, password: 'Pass123!', role: 'operator', disabled: true });
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: disabledEmail, password: 'Pass123!' }),
      });
      expect(r.statusCode).toBe(403);
    });

    it('returns 429 after exceeding 5 attempts in 15min', async () => {
      const email = `ratelimit-${Date.now()}@example.test`;
      await seedUser(pool, { email, password: 'Pass123!', role: 'operator' });
      for (let i = 0; i < 5; i += 1) {
        const r = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ email, password: 'wrong-pass' }),
        });
        expect(r.statusCode).toBe(401);
      }
      const sixth = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email, password: 'Pass123!' }),
      });
      expect(sixth.statusCode).toBe(429);
      const body = sixth.json() as { code: string };
      expect(body.code).toBe('rate_limited');
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('returns 200 and clears the cookie for a valid session, emits audit auth.logout', async () => {
      const loginR = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: operatorEmail, password: operatorPass }),
      });
      const cookie = cookieFromSetCookie(loginR.headers['set-cookie'], 'sid');
      expect(cookie).not.toBeNull();
      const before = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_log WHERE action = 'auth.logout'`,
      );
      const logoutR = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { cookie: cookie ?? '' },
      });
      expect(logoutR.statusCode).toBe(200);
      const cleared = cookieFromSetCookie(logoutR.headers['set-cookie'], 'sid');
      expect(cleared).not.toBeNull();
      expect(cleared).toMatch(/^sid=;|^sid=$/);

      const after = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_log WHERE action = 'auth.logout'`,
      );
      expect(Number(after.rows[0]?.count)).toBeGreaterThan(Number(before.rows[0]?.count));
    });

    it('returns 401 without a session cookie', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
      });
      expect(r.statusCode).toBe(401);
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('returns 200 + user info for a valid session', async () => {
      const loginR = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: adminEmail, password: adminPass }),
      });
      const cookie = cookieFromSetCookie(loginR.headers['set-cookie'], 'sid');
      expect(cookie).not.toBeNull();
      const r = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie: cookie ?? '' },
      });
      expect(r.statusCode).toBe(200);
      const me = r.json() as { id: number; email: string; role: string };
      expect(me.id).toBe(seededAdminId);
      expect(me.email).toBe(adminEmail);
      expect(me.role).toBe('admin');
    });

    it('returns 401 without a session cookie', async () => {
      const r = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
      });
      expect(r.statusCode).toBe(401);
    });

    it('returns 401 with an invalid session token', async () => {
      const r = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie: 'sid=this-is-not-a-real-token' },
      });
      expect(r.statusCode).toBe(401);
    });
  });

  describe('argon2id migration (WU5)', () => {
    /**
     * Insert a user whose password_hash is a pre-computed string (bcrypt or
     * argon2id). Used by the migration tests below. Returns the inserted
     * user id.
     */
    async function seedUserWithHash(
      pool: Pool,
      email: string,
      hash: string,
      role: 'admin' | 'operator' | 'auditor' = 'operator',
    ): Promise<number> {
      const r = await pool.query<{ id: number }>(
        `INSERT INTO users (email, password_hash, role)
         VALUES (lower($1), $2, $3)
         RETURNING id`,
        [email, hash, role],
      );
      const id = r.rows[0]?.id;
      if (!id) throw new Error('user_seed_failed');
      return id;
    }

    it('upgrades a legacy bcrypt hash to argon2id on successful login', async () => {
      const email = `migrate-up-${Date.now()}@example.test`;
      const password = 'M1gr@tePw!';
      const bcryptHash = await bcrypt.hash(password, BCRYPT_COST);
      expect(bcryptHash.startsWith('$2')).toBe(true);
      await seedUserWithHash(pool, email, bcryptHash);

      // Baseline: stored hash is a bcrypt hash before login.
      const before = await pool.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE email = lower($1)`,
        [email],
      );
      expect(before.rows[0]?.password_hash).toBe(bcryptHash);

      // Successful login.
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email, password }),
      });
      expect(r.statusCode).toBe(200);

      // After login, the stored hash must have been transparently
      // re-written as an argon2id PHC string.
      const after = await pool.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE email = lower($1)`,
        [email],
      );
      const newHash = after.rows[0]?.password_hash;
      expect(newHash).toBeDefined();
      expect(newHash).not.toBe(bcryptHash);
      expect(newHash?.startsWith('$argon2id$')).toBe(true);
    });

    it('does not re-write an already-argon2id hash on successful login (idempotent)', async () => {
      const email = `migrate-keep-${Date.now()}@example.test`;
      const password = 'Idemp0tentPw!';
      const argonHash = await hashPassword(password);
      expect(argonHash.startsWith('$argon2id$')).toBe(true);
      await seedUserWithHash(pool, email, argonHash);

      // Login.
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email, password }),
      });
      expect(r.statusCode).toBe(200);

      // Hash must be byte-identical to what we seeded.
      const after = await pool.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE email = lower($1)`,
        [email],
      );
      expect(after.rows[0]?.password_hash).toBe(argonHash);
    });
  });
});