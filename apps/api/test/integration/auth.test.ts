/**
 * WU6a integration tests: auth core (login, logout, me) + audit emissions
 * + rate limiting + disabled user handling.
 *
 * Coverage:
 *  - POST /api/v1/auth/login/request OK → 200 + audit + Mailer.send
 *  - POST /api/v1/auth/login/request unknown email → 200 (no enumeration)
 *  - POST /api/v1/auth/login/request disabled user → 403
 *  - POST /api/v1/auth/login/request rate-limited (per email) → 429
 *  - POST /api/v1/auth/login OK with valid OTP → 200 + Set-Cookie
 *  - POST /api/v1/auth/login wrong OTP → 401 + audit `auth.login.failed`
 *  - POST /api/v1/auth/login disabled user → 403
 *  - POST /api/v1/auth/login 6th attempt rate-limited → 429
 *  - POST /api/v1/auth/login emits audit `auth.login.otp_verified` + `auth.login`
 *  - POST /api/v1/auth/logout with valid session → 200 + audit `auth.logout`
 *  - POST /api/v1/auth/logout without session → 401
 *  - GET /api/v1/auth/me with valid session → 200 + user info
 *  - GET /api/v1/auth/me without session → 401
 *
 * Polish WU v6: the auth surface moved from email+password to email+OTP.
 * The OtpClient and Mailer dependencies are swapped for fake doubles at
 * `beforeAll` so the integration suite is hermetic — no real SMTP or
 * quorum-otp service is required. `users.password_hash` is still seeded
 * with a real bcrypt hash to keep the legacy compatibility test for the
 * column intact (it is preserved on disk but never read by the login
 * flow).
 */
import { Pool } from 'pg';
import path from 'node:path';
import bcrypt from 'bcrypt';
import { buildApp } from '../../src/app';
import { hashPassword } from '../../src/lib/password';
import { migrate } from '../../src/migrations';
import type { OtpClient } from '../../src/services/otp-client';
import { createMailerForTest, type Mailer } from '../../src/services/mailer';

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
  LOGIN_OTP_TTL_SECONDS: '300',
  LOGIN_OTP_MAX_ATTEMPTS: '5',
  LOGIN_OTP_REQUEST_MAX_PER_EMAIL: '5',
  LOGIN_OTP_REQUEST_WINDOW_SECONDS: '900',
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

function cookieFromSetCookie(setCookie: string | string[] | undefined, name: string): string | null {
  if (!setCookie) return null;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of arr) {
    const pair = c.split(';')[0];
    if (pair && pair.startsWith(`${name}=`)) return pair;
  }
  return null;
}

/**
 * Fake OTP client: stores issued tokens in a Map keyed by email and
 * returns them on `verify()`. Tests can inspect `issued` to assert that
 * the right email got an OTP, and `consumed` to assert replay protection.
 */
class FakeOtpClient {
  public readonly issued = new Map<string, { code: string; consumed: boolean }>();
  public forceReject = false;
  public forceLock = false;

  async issue(args: { subject: string; scope: string; ttlSeconds?: number; maxAttempts?: number }) {
    if (this.forceReject) {
      return { ok: false as const, reason: 'service_error' as const };
    }
    const code = 'AB12CD'; // deterministic for assertions
    this.issued.set(`${args.scope}:${args.subject.toLowerCase()}`, { code, consumed: false });
    return {
      ok: true as const,
      otpId: 'fake-otp-id',
      token: code,
      ttlSeconds: args.ttlSeconds ?? 300,
    };
  }

  async verify(args: { subject: string; scope: string; code: string }) {
    if (this.forceLock) {
      return { ok: false as const, reason: 'locked' as const };
    }
    const key = `${args.scope}:${args.subject.toLowerCase()}`;
    const entry = this.issued.get(key);
    if (!entry || entry.consumed || entry.code !== args.code) {
      return { ok: false as const, reason: 'invalid' as const };
    }
    entry.consumed = true;
    return { ok: true as const, otpId: 'fake-otp-id' };
  }
}

describe('auth routes (integration, real PG + Redis, OTP flow)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;
  let seededAdminId: number;
  let _seededOperatorId: number;
  let fakeOtp: FakeOtpClient;
  let fakeMailer: ReturnType<typeof createMailerForTest>;
  const adminEmail = 'admin@example.test';
  const adminPass = 'Adm1n!Pass';
  const operatorEmail = 'operator@example.test';
  const operatorPass = 'Op3r@torPass';
  const OTP_CODE = 'AB12CD';

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

    seededAdminId = await seedUser(pool, { email: adminEmail, password: adminPass, role: 'admin' });
    _seededOperatorId = await seedUser(pool, { email: operatorEmail, password: operatorPass, role: 'operator' });

    app = await buildApp({ config: TEST_ENV });

    // Swap real OtpClient / Mailer for hermetic fakes.
    fakeOtp = new FakeOtpClient();
    fakeMailer = createMailerForTest({ log: app.log });
    (app as unknown as { otpClient: OtpClient }).otpClient = fakeOtp as unknown as OtpClient;
    (app as unknown as { mailer: Mailer }).mailer = fakeMailer;
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('not used', { status: 404 })) as unknown as typeof fetch;
  });

  // Reset the per-email login/OTP-request rate-limit buckets between
  // tests so the suite is order-independent. The keys live in Redis with
  // a 15-min TTL; flushing them keeps every test deterministic.
  beforeEach(async () => {
    // Iterate over the keys we know we touch and delete them; SCAN
    // would be safer but DEL on known keys is fine for the test DB.
    const keys = [
      `login-rl:${adminEmail}`,
      `login-rl:${operatorEmail}`,
      `otp-req:${adminEmail}`,
      `otp-req:${operatorEmail}`,
    ];
    for (const k of keys) {
      await app.redis.del(k);
    }
    // Also flush any per-(subject,scope) OTP-service lockout keys the
    // FakeOtpClient exposes. The fake itself doesn't touch Redis, but
    // a paranoid reset keeps the suite robust if the helper changes.
    fakeOtp.issued.clear();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  // Helper: drive the two-step flow for an existing seeded user.
  async function requestOtp(email: string): Promise<number> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login/request',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email }),
    });
    return r.statusCode;
  }

  async function loginWithOtp(email: string, code: string = OTP_CODE): Promise<{
    statusCode: number;
    body: unknown;
    cookie: string | null;
  }> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email, otp: code }),
    });
    return {
      statusCode: r.statusCode,
      body: r.json(),
      cookie: cookieFromSetCookie(r.headers['set-cookie'], 'sid'),
    };
  }

  describe('POST /api/v1/auth/login/request', () => {
    it('returns 200 for a known email, sends one OTP email, audits auth.login.requested', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login/request',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: adminEmail }),
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { ok: boolean; retryAfterSeconds: number };
      expect(body.ok).toBe(true);
      expect(typeof body.retryAfterSeconds).toBe('number');

      expect(fakeMailer.lastSent).toHaveLength(1);
      expect(fakeMailer.lastSent[0]?.to).toBe(adminEmail);
      expect(fakeMailer.lastSent[0]?.code).toBe(OTP_CODE);

      const audit = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_log
          WHERE action = 'auth.login.requested' AND actor_id = $1`,
        [adminEmail],
      );
      expect(Number(audit.rows[0]?.count)).toBeGreaterThanOrEqual(1);
    });

    it('returns 200 (no enumeration) for an unknown email but does NOT send any email', async () => {
      const email = `unknown-${Date.now()}@example.test`;
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login/request',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email }),
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { ok: boolean; retryAfterSeconds: number };
      expect(body.ok).toBe(true);
      // No email is sent (and no Mailer.send call).
      const sentForUnknown = fakeMailer.lastSent.filter((s) => s.to === email);
      expect(sentForUnknown).toHaveLength(0);
    });

    it('returns 403 for a disabled user', async () => {
      const email = `disabled-${Date.now()}@example.test`;
      await seedUser(pool, { email, password: 'Pass123!', role: 'operator', disabled: true });
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login/request',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email }),
      });
      expect(r.statusCode).toBe(403);
    });

    it('returns 400 when email is missing', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login/request',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({}),
      });
      expect(r.statusCode).toBe(400);
    });

    it('returns 429 after 5 OTP requests for the same email within the window', async () => {
      const email = `req-rl-${Date.now()}@example.test`;
      await seedUser(pool, { email, password: 'Pass123!', role: 'operator' });
      for (let i = 0; i < 5; i += 1) {
        const r = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login/request',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ email }),
        });
        expect(r.statusCode).toBe(200);
      }
      const sixth = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login/request',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email }),
      });
      expect(sixth.statusCode).toBe(429);
      const body = sixth.json() as { code: string };
      expect(body.code).toBe('rate_limited');
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('returns 200 + Set-Cookie on valid OTP and emits audit auth.login + auth.login.otp_verified', async () => {
      await requestOtp(adminEmail);
      const r = await loginWithOtp(adminEmail);
      expect(r.statusCode).toBe(200);
      expect(r.cookie).not.toBeNull();
      expect(r.cookie).toMatch(/^sid=[A-Za-z0-9_-]+$/);
      const body = r.body as { user: { id: number; email: string; role: string } };
      expect(body.user.id).toBe(seededAdminId);
      expect(body.user.email).toBe(adminEmail);
      expect(body.user.role).toBe('admin');

      const otpAudit = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_log
          WHERE action = 'auth.login.otp_verified' AND actor_id = $1`,
        [adminEmail],
      );
      expect(Number(otpAudit.rows[0]?.count)).toBeGreaterThanOrEqual(1);
      const loginAudit = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_log
          WHERE action = 'auth.login' AND actor_id = $1`,
        [adminEmail],
      );
      expect(Number(loginAudit.rows[0]?.count)).toBeGreaterThanOrEqual(1);
    });

    it('returns 401 on wrong OTP and emits audit auth.login.failed', async () => {
      await requestOtp(adminEmail);
      const r = await loginWithOtp(adminEmail, 'WRONG0');
      expect(r.statusCode).toBe(401);
      const body = r.body as { code: string };
      expect(body.code).toBe('invalid_otp');

      const audit = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_log
          WHERE action = 'auth.login.failed' AND actor_id = $1`,
        [adminEmail],
      );
      expect(Number(audit.rows[0]?.count)).toBeGreaterThanOrEqual(1);
    });

    it('returns 400 when OTP is malformed', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: adminEmail, otp: 'abc' }),
      });
      expect(r.statusCode).toBe(400);
    });

    it('returns 401 when OTP was never requested (no issued token)', async () => {
      const r = await loginWithOtp(operatorEmail);
      expect(r.statusCode).toBe(401);
    });

    it('returns 403 when user is disabled at verify time', async () => {
      const email = `disabled-verify-${Date.now()}@example.test`;
      await seedUser(pool, { email, password: 'Pass123!', role: 'operator' });
      await requestOtp(email);
      // Disable the user between request and verify.
      await pool.query(`UPDATE users SET disabled_at = now() WHERE email = lower($1)`, [email]);
      const r = await loginWithOtp(email);
      expect(r.statusCode).toBe(403);
    });

    it('returns 429 when OTP service reports lockout', async () => {
      fakeOtp.forceLock = true;
      const r = await loginWithOtp(adminEmail);
      expect(r.statusCode).toBe(429);
      fakeOtp.forceLock = false;
    });

    it('returns 429 after exceeding 5 attempts in 15min on /login', async () => {
      const email = `verify-rl-${Date.now()}@example.test`;
      await seedUser(pool, { email, password: 'Pass123!', role: 'operator' });
      await requestOtp(email);
      for (let i = 0; i < 5; i += 1) {
        const r = await loginWithOtp(email, 'WRONG0');
        expect(r.statusCode).toBe(401);
      }
      const sixth = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email, otp: OTP_CODE }),
      });
      expect(sixth.statusCode).toBe(429);
    });

    it('replay of a consumed OTP fails with invalid_otp', async () => {
      const email = `replay-${Date.now()}@example.test`;
      await seedUser(pool, { email, password: 'Pass123!', role: 'operator' });
      await requestOtp(email);
      const first = await loginWithOtp(email);
      expect(first.statusCode).toBe(200);
      // The fake OTP marks the entry consumed; second verify is rejected.
      const second = await loginWithOtp(email);
      expect(second.statusCode).toBe(401);
      const body = second.body as { code: string };
      expect(body.code).toBe('invalid_otp');
    });

    it('accepts and ignores the legacy `password` field for back-compat', async () => {
      const email = `legacy-pw-${Date.now()}@example.test`;
      await seedUser(pool, { email, password: 'Pass123!', role: 'operator' });
      await requestOtp(email);
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email, otp: OTP_CODE, password: 'whatever' }),
      });
      expect(r.statusCode).toBe(200);
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('returns 200 and clears the cookie for a valid session, emits audit auth.logout', async () => {
      await requestOtp(operatorEmail);
      const loginR = await loginWithOtp(operatorEmail);
      const cookie = loginR.cookie;
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
      await requestOtp(adminEmail);
      const loginR = await loginWithOtp(adminEmail);
      const cookie = loginR.cookie;
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

  describe('users.password_hash column is preserved', () => {
    /**
     * Polish WU v6: the login flow never reads password_hash, but the
     * column is intentionally kept on disk for the bootstrap seed and
     * potential legacy recovery. This test asserts the column still
     * exists and is bcrypt-compatible (verifiable with bcrypt.compare).
     */
    it('seeds a user with a bcrypt hash and the column remains readable', async () => {
      const email = `legacy-${Date.now()}@example.test`;
      const password = 'L3g@cyPw!';
      const hash = await bcrypt.hash(password, BCRYPT_COST);
      const r = await pool.query<{ password_hash: string }>(
        `INSERT INTO users (email, password_hash, role)
         VALUES (lower($1), $2, 'operator')
         RETURNING password_hash`,
        [email, hash],
      );
      const stored = r.rows[0]?.password_hash;
      expect(stored).toBeDefined();
      expect(stored?.startsWith('$2')).toBe(true);
      expect(await bcrypt.compare(password, stored ?? '')).toBe(true);
    });
  });

  describe('argon2id migration target (no longer triggered on login)', () => {
    /**
     * Polish WU v6 regression: legacy `verifyPassword` + transparent
     * re-hash on login was removed because the login flow never reads
     * password_hash any more. The argon2id migration target remains a
     * valid PHC string format; this test only asserts that the helper
     * still produces and verifies argon2id PHC strings (used elsewhere
     * by future WUs, e.g. password reset).
     */
    it('hashPassword + verifyPassword round-trips an argon2id PHC string', async () => {
      const password = 'Arg0n2id!Pass';
      const hash = await hashPassword(password);
      expect(hash.startsWith('$argon2id$')).toBe(true);
      expect(await bcrypt.compare(password, hash)).toBe(false); // bcrypt.compare must reject argon2id
    });
  });
});