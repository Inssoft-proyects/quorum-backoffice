/**
 * WU6a integration tests: auth core (login, logout, me) + audit emissions
 * + rate limiting + disabled-user handling under the single-step
 * username + pre-issued OTP contract.
 *
 * Coverage:
 *  - POST /api/v1/auth/login OK with valid OTP → 200 + Set-Cookie + audit
 *  - POST /api/v1/auth/login unknown username → 401 invalid_credentials
 *  - POST /api/v1/auth/login cannot authenticate a row without an assigned username
 *  - POST /api/v1/auth/login disabled user → 403
 *  - POST /api/v1/auth/login rate-limited (per username) → 429
 *  - POST /api/v1/auth/login wrong OTP → 401 invalid_credentials
 *  - POST /api/v1/auth/login replayed/consumed OTP → 401 invalid_credentials
 *  - POST /api/v1/auth/login OTP service lockout → 429
 *  - POST /api/v1/auth/login emits audit `auth.login.otp_verified` + `auth.login`
 *  - POST /api/v1/auth/logout with valid session → 200 + audit `auth.logout`
 *  - POST /api/v1/auth/logout without session → 401
 *  - GET  /api/v1/auth/me with valid session → 200 + user info
 *  - GET  /api/v1/auth/me without session → 401
 *
 * The single-step flow does NOT expose a `/auth/login/request` endpoint
 * and does NOT call a mailer. Tests issue fake OTPs directly via a
 * FakeOtpClient whose `verify` resolves the pre-bound code for the
 * username subject, mirroring what an external issuer would have done
 * out-of-band. `users.password_hash` is still seeded with a real bcrypt
 * hash to keep the legacy column-compat test intact (the column is
 * preserved on disk but never read by the login flow).
 */
import { Pool } from 'pg';
import path from 'node:path';
import bcrypt from 'bcrypt';
import { buildApp } from '../../src/app';
import { hashPassword } from '../../src/lib/password';
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
  LOGIN_OTP_MAX_ATTEMPTS: '5',
  LOGIN_OTP_REQUEST_WINDOW_SECONDS: '900',
};

const BCRYPT_COST = 10; // lower than production (12) to keep tests fast

interface SeedUser {
  /** BackOffice role; preserved on every insert. */
  role: 'admin' | 'operator' | 'auditor';
  /**
   * Canonical login identifier. Must be a valid BackOffice username
   * (3-32 chars, alnum + . _ -); this is the subject the FakeOtpClient
   * uses for verify(). Email is intentionally unused on the new contract.
   */
  username: string;
  /** Email kept for legacy column-compat; login never reads it. */
  email: string;
  password: string;
  disabled?: boolean;
  /** When true, the row exists but `users.username IS NULL` (unmapped). */
  unmapped?: boolean;
}

async function seedUser(pool: Pool, u: SeedUser): Promise<number> {
  const hash = await bcrypt.hash(u.password, BCRYPT_COST);
  const usernameColumnValue = u.unmapped ? null : u.username;
  const r = await pool.query<{ id: number }>(
    `INSERT INTO users (email, username, password_hash, role, disabled_at)
     VALUES (lower($1), $2, $3, $4, ${u.disabled ? 'now()' : 'NULL'})
     RETURNING id`,
    [u.email, usernameColumnValue, hash, u.role],
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
 * Fake OTP client: tests pre-issue a deterministic OTP for each
 * (scope, subject) pair by calling `issue()` directly — mirroring what
 * the broader quorum ecosystem would have done out-of-band. `verify()`
 * matches the pre-issued code, honours single-use replay protection,
 * and supports `forceLock` to simulate the upstream provider returning
 * a lockout. The login flow only calls `verify`, never `issue`; we keep
 * `issue` here so the test fixture stays self-contained.
 */
class FakeOtpClient {
  public readonly issued = new Map<string, { code: string; consumed: boolean }>();
  public forceReject = false;
  public forceLock = false;

  async issue(args: { subject: string; scope: string; ttlSeconds?: number; maxAttempts?: number }): Promise<{ ok: true; otpId: string; token: string; ttlSeconds: number }> {
    if (this.forceReject) {
      return { ok: true as const, otpId: 'fake-otp-id', token: 'AB12CD', ttlSeconds: args.ttlSeconds ?? 300 };
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

  async verify(args: { subject: string; scope: string; code: string }): Promise<{ ok: true; otpId: string } | { ok: false; reason: 'invalid' | 'locked' | 'expired' | 'rate_limited' | 'unknown' }> {
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

describe('auth routes (integration, real PG + Redis, single-step username + pre-issued OTP)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;
  let seededAdminId: number;
  let _seededOperatorId: number;
  let fakeOtp: FakeOtpClient;
  // Canonical usernames are the new login identifier. Emails are kept
  // for the column-compat tests and the MeResponse payload.
  const adminUsername = 'auth-admin';
  const adminEmail = 'auth-admin@example.test';
  const adminPass = 'Adm1n!Pass';
  const operatorUsername = 'auth-operator';
  const operatorEmail = 'auth-operator@example.test';
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

    seededAdminId = await seedUser(pool, {
      username: adminUsername,
      email: adminEmail,
      password: adminPass,
      role: 'admin',
    });
    _seededOperatorId = await seedUser(pool, {
      username: operatorUsername,
      email: operatorEmail,
      password: operatorPass,
      role: 'operator',
    });

    app = await buildApp({ config: TEST_ENV });

    // Swap real OtpClient for a hermetic fake. There is no mailer in
    // the new contract — the BackOffice never emails an OTP.
    fakeOtp = new FakeOtpClient();
    (app as unknown as { otpClient: OtpClient }).otpClient = fakeOtp as unknown as OtpClient;
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('not used', { status: 404 })) as unknown as typeof fetch;
  });

  // Reset per-username login rate-limit buckets between tests so the
  // suite is order-independent. The Redis key is now keyed by the
  // canonical username (see apps/api/src/lib/rate-limit.ts), not by
  // email.
  beforeEach(async () => {
    const keys = [
      `login_attempts:${adminUsername}`,
      `login_attempts:${operatorUsername}`,
    ];
    for (const k of keys) {
      await app.redis.del(k);
    }
    fakeOtp.issued.clear();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  /**
   * Pre-issue an OTP for the given username subject. This stands in
   * for what the broader quorum ecosystem would have delivered out of
   * band; the BackOffice `/auth/login` route never issues codes.
   */
  async function issueOtp(username: string): Promise<void> {
    await fakeOtp.issue({ subject: username, scope: 'login' });
  }

  async function loginWithOtp(username: string, code: string = OTP_CODE): Promise<{
    statusCode: number;
    body: unknown;
    cookie: string | null;
  }> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username, otp: code }),
    });
    return {
      statusCode: r.statusCode,
      body: r.json(),
      cookie: cookieFromSetCookie(r.headers['set-cookie'], 'sid'),
    };
  }

  describe('POST /api/v1/auth/login', () => {
    it('returns 200 + Set-Cookie on valid OTP and emits audit auth.login + auth.login.otp_verified', async () => {
      await issueOtp(adminUsername);
      const r = await loginWithOtp(adminUsername);
      expect(r.statusCode).toBe(200);
      expect(r.cookie).not.toBeNull();
      expect(r.cookie).toMatch(/^sid=[A-Za-z0-9_-]+$/);
      const body = r.body as { user: { id: number; email: string; role: string } };
      expect(body.user.id).toBe(seededAdminId);
      // Email is preserved on MeResponse for legacy UI/audit consumers
      // even though the login identifier is now the username.
      expect(body.user.email).toBe(adminEmail);
      expect(body.user.role).toBe('admin');

      // Audit emits actorId = canonical username (audit log records
      // the login identifier, not the email).
      const otpAudit = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_log
          WHERE action = 'auth.login.otp_verified' AND actor_id = $1`,
        [adminUsername],
      );
      expect(Number(otpAudit.rows[0]?.count)).toBeGreaterThanOrEqual(1);
      const loginAudit = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_log
          WHERE action = 'auth.login' AND actor_id = $1`,
        [adminUsername],
      );
      expect(Number(loginAudit.rows[0]?.count)).toBeGreaterThanOrEqual(1);
    });

    it('returns 401 invalid_credentials for an unknown username (no enumeration)', async () => {
      const r = await loginWithOtp('ghost-user');
      expect(r.statusCode).toBe(401);
      const body = r.body as { code: string };
      expect(body.code).toBe('invalid_credentials');

      // Audit discriminates the cause in entityId; the actorId is the
      // canonical username so brute-force sweeps are observable.
      const audit = await pool.query<{ count: string; actor_id: string; entity_id: string }>(
        `SELECT count(*)::text AS count, actor_id, entity_id
           FROM audit_log
          WHERE action = 'auth.login.failed' AND actor_id = $1
          GROUP BY actor_id, entity_id`,
        ['ghost-user'],
      );
      expect(Number(audit.rows[0]?.count)).toBeGreaterThanOrEqual(1);
      expect(audit.rows[0]?.entity_id).toBe('unknown_user');
    });

    it('does not authenticate an account until a username is assigned', async () => {
      await seedUser(pool, {
        username: 'never-assigned',
        email: `unmapped-${Date.now()}@example.test`,
        password: 'Pass123!',
        role: 'operator',
        unmapped: true,
      });
      // Login accepts only a username, so an account row with username
      // NULL is intentionally indistinguishable from an unknown username.
      // Production rollout must assign the username out of band first.
      const r = await loginWithOtp('never-assigned');
      expect(r.statusCode).toBe(401);
      expect((r.body as { code: string }).code).toBe('invalid_credentials');
    });

    it('returns 401 invalid_credentials on a wrong OTP and emits audit auth.login.failed', async () => {
      await issueOtp(adminUsername);
      const r = await loginWithOtp(adminUsername, 'WRONG0');
      expect(r.statusCode).toBe(401);
      const body = r.body as { code: string };
      expect(body.code).toBe('invalid_credentials');

      const audit = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_log
          WHERE action = 'auth.login.failed' AND actor_id = $1`,
        [adminUsername],
      );
      expect(Number(audit.rows[0]?.count)).toBeGreaterThanOrEqual(1);
    });

    it('returns 400 when OTP is malformed (fails Zod validation)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ username: adminUsername, otp: 'abc' }),
      });
      expect(r.statusCode).toBe(400);
    });

    it('returns 401 when no OTP was pre-issued for the username subject', async () => {
      const r = await loginWithOtp(operatorUsername);
      expect(r.statusCode).toBe(401);
      const body = r.body as { code: string };
      expect(body.code).toBe('invalid_credentials');
    });

    it('returns 403 user_disabled when the account is disabled', async () => {
      const username = `auth-disabled-${Date.now()}`;
      await seedUser(pool, {
        username,
        email: `${username}@example.test`,
        password: 'Pass123!',
        role: 'operator',
        disabled: true,
      });
      await issueOtp(username);
      const r = await loginWithOtp(username);
      expect(r.statusCode).toBe(403);
      const body = r.body as { code: string };
      expect(body.code).toBe('user_disabled');
    });

    it('returns 429 when the OTP service reports lockout', async () => {
      await issueOtp(adminUsername);
      fakeOtp.forceLock = true;
      const r = await loginWithOtp(adminUsername);
      expect(r.statusCode).toBe(429);
      const body = r.body as { code: string };
      expect(body.code).toBe('rate_limited');
      fakeOtp.forceLock = false;
    });

    it('returns 429 after exceeding 5 attempts in 15min on /login (per-username)', async () => {
      const username = `auth-ratelimit-${Date.now()}`;
      await seedUser(pool, {
        username,
        email: `${username}@example.test`,
        password: 'Pass123!',
        role: 'operator',
      });
      await issueOtp(username);
      for (let i = 0; i < 5; i += 1) {
        const r = await loginWithOtp(username, 'WRONG0');
        expect(r.statusCode).toBe(401);
      }
      const sixth = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ username, otp: OTP_CODE }),
      });
      expect(sixth.statusCode).toBe(429);
    });

    it('replay of a consumed OTP fails with invalid_credentials (single-use)', async () => {
      const username = `auth-replay-${Date.now()}`;
      await seedUser(pool, {
        username,
        email: `${username}@example.test`,
        password: 'Pass123!',
        role: 'operator',
      });
      await issueOtp(username);
      const first = await loginWithOtp(username);
      expect(first.statusCode).toBe(200);
      // FakeOtpClient marks the entry consumed; second verify is rejected.
      const second = await loginWithOtp(username);
      expect(second.statusCode).toBe(401);
      const body = second.body as { code: string };
      expect(body.code).toBe('invalid_credentials');
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('returns 200 and clears the cookie for a valid session, emits audit auth.logout', async () => {
      await issueOtp(operatorUsername);
      const loginR = await loginWithOtp(operatorUsername);
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
      await issueOtp(adminUsername);
      const loginR = await loginWithOtp(adminUsername);
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
     * Polish WU v6 + username migration: the login flow never reads
     * password_hash, but the column is intentionally kept on disk for
     * the bootstrap seed and potential legacy recovery. This test
     * asserts the column still exists and is bcrypt-compatible.
     */
    it('seeds a user with a bcrypt hash and the column remains readable', async () => {
      const username = `pw-${Date.now()}`;
      const email = `${username}@example.test`;
      const password = 'L3g@cyPw!';
      const hash = await bcrypt.hash(password, BCRYPT_COST);
      const r = await pool.query<{ password_hash: string }>(
        `INSERT INTO users (email, username, password_hash, role)
         VALUES (lower($1), $2, $3, 'operator')
         RETURNING password_hash`,
        [email, username, hash],
      );
      const stored = r.rows[0]?.password_hash;
      expect(stored).toBeDefined();
      expect(stored?.startsWith('$2')).toBe(true);
      expect(await bcrypt.compare(password, stored ?? '')).toBe(true);
    });
  });

  describe('argon2id migration target (no longer triggered on login)', () => {
    /**
     * Polish WU v6 + username migration regression: the legacy
     * `verifyPassword` + transparent re-hash on login was removed
     * because the login flow never reads password_hash any more. The
     * argon2id migration target remains a valid PHC string format; this
     * test only asserts that the helper still produces and verifies
     * argon2id PHC strings (used elsewhere by future WUs, e.g. password
     * reset).
     */
    it('hashPassword produces an argon2id PHC string', async () => {
      const password = 'Arg0n2id!Pass';
      const hash = await hashPassword(password);
      expect(hash.startsWith('$argon2id$')).toBe(true);
      expect(await bcrypt.compare(password, hash)).toBe(false); // bcrypt.compare must reject argon2id
    });
  });
});