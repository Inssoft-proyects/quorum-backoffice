// B7a (P5.1) — service identity propagation.
//
// Defect: `registerDispositivosRoutes` and `registerMarbetesRoutes`
// constructed their own OtpClient WITHOUT `serviceName`, so the
// destructive HTTP surface always signed as the default
// 'quorum-backoffice' and ignored the operator-configured
// OTP_SERVICE_NAME. The fix is a one-line addition in each route:
// pass `serviceName: app.config.OTP_SERVICE_NAME` to the inline
// OtpClient constructor.
//
// This file exercises the full PG-backed Fastify app with a
// non-default OTP_SERVICE_NAME and asserts that the HMAC
// `Authorization: HMAC <serviceName> <ts> <hex>` header
// signed by the destructive routes carries the configured name
// (not the default). The fetch is replaced at the global level
// so we can capture the wire bytes without standing up a real
// quorum-otp.
//
// RED before the route fix: the captured header is
//   `HMAC quorum-backoffice <ts> <hex>` — the default, ignoring
//   OTP_SERVICE_NAME. GREEN after the fix: the captured header is
//   `HMAC <configured-name> <ts> <hex>`.

import { Pool } from 'pg';
import path from 'node:path';
import bcrypt from 'bcrypt';
import { buildApp } from '../../src/app';
import { migrate } from '../../src/migrations';
import { resetConfigForTests } from '../../src/config';
import type { OtpClient } from '../../src/services/otp-client';

const TEST_DATABASE_URL =
  process.env['DATABASE_URL_TEST'] ??
  'postgresql://websop:quorum_backoffice_dev@127.0.0.1:5432/quorum_backoffice_test';

const VALID_OTP = '123456';

/**
 * Mirror of the devices/marbetes integration test env but with a
 * non-default OTP_SERVICE_NAME so the assertion can prove the
 * configured name reaches the wire.
 */
function makeTestEnv(serviceName: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    API_PORT: '3099',
    API_HOST: '127.0.0.1',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
    OTP_SERVICE_URL: 'http://127.0.0.1:65535',
    OTP_SERVICE_TOKEN: 'test-otp-token-1234567890',
    OTP_SERVICE_NAME: serviceName,
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
}

interface CapturedCall {
  url: string;
  authorization: string | null;
  body: string;
}

function makeCapturingOtpFetch(): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const authorization =
      (init?.headers as Record<string, string> | undefined)?.['authorization'] ?? null;
    const body = init?.body ? String(init.body) : '';
    calls.push({ url, authorization, body });
    if (url.includes('/v1/otps/verify')) {
      const parsed = JSON.parse(body) as { token?: string };
      if (parsed.token === VALID_OTP) {
        return new Response(JSON.stringify({ id: 'b7a-captured-otp', valid: true }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ error: 'verify_rejected' }), { status: 409 });
    }
    return new Response('not used', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

class FakeOtpClient {
  async issue(_args: { subject: string; scope: string }) {
    return { ok: true as const, otpId: 'fake', token: VALID_OTP, ttlSeconds: 300 };
  }
  async verify(args: { subject: string; scope: string; code: string }) {
    if (args.code !== VALID_OTP) return { ok: false as const, reason: 'invalid' as const };
    return { ok: true as const, otpId: 'fake' };
  }
}

async function seedAdmin(pool: Pool): Promise<{ username: string; email: string }> {
  const tag = `b7a-${Date.now()}`;
  const hash = await bcrypt.hash('Throw@way1', 10);
  await pool.query(
    `INSERT INTO users (email, username, password_hash, role)
     VALUES (lower($1), $2, $3, 'admin')`,
    [`${tag}@example.test`, tag, hash],
  );
  return { username: tag, email: `${tag}@example.test` };
}

async function seedDevice(pool: Pool, serial: string): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO dispositivos (serial_number, brand, model, status, created_by)
     VALUES ($1, 'TestBrand', 'TestModel', 'active'::dispositivo_status, 'tester') RETURNING id`,
    [serial],
  );
  return r.rows[0]!.id;
}

async function seedMarbete(pool: Pool, code: string): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO marbetes (code, status, created_by)
     VALUES ($1, 'active'::marbete_status, 'tester') RETURNING id`,
    [code],
  );
  return r.rows[0]!.id;
}

async function seedStudent(pool: Pool, canvasId: number): Promise<void> {
  await pool.query(
    `INSERT INTO students_cache (canvas_user_id, full_name, email, is_active)
     VALUES ($1, 'B7A Student', $2, TRUE)`,
    [canvasId, `b7a-${canvasId}@example.test`],
  );
}

describe('B7a — destructive route HMAC serviceName propagation', () => {
  let pool: Pool;
  let savedFetch: typeof fetch;

  beforeAll(async () => {
    savedFetch = globalThis.fetch;
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
  });

  afterAll(async () => {
    globalThis.fetch = savedFetch;
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE audit_log RESTART IDENTITY`);
    await pool.query(`DELETE FROM dispositivos`);
    await pool.query(`DELETE FROM marbetes`);
    await pool.query(`DELETE FROM students_cache`);
  });

  async function buildAppWithServiceName(serviceName: string) {
    // loadConfig() caches at module scope; each test uses a distinct
    // OTP_SERVICE_NAME, so we MUST reset the cache before the new
    // buildApp() call or the second test inherits the first test's
    // config (and the serviceName assertion would be meaningless).
    resetConfigForTests();
    const app = await buildApp({ config: makeTestEnv(serviceName) });
    (app as unknown as { otpClient: OtpClient }).otpClient =
      new FakeOtpClient() as unknown as OtpClient;
    const { fetch, calls } = makeCapturingOtpFetch();
    (globalThis as { fetch: typeof fetch }).fetch = fetch;
    return { app, calls };
  }

  it('dispositivos assign signs the HMAC header with the configured OTP_SERVICE_NAME', async () => {
    const { app, calls } = await buildAppWithServiceName('backoffice-dispositivos');
    try {
      const admin = await seedAdmin(pool);
      const deviceId = await seedDevice(pool, `SN-B7A-DISP-${Date.now()}`);
      await seedStudent(pool, 80_900);

      const r = await app.inject({
        method: 'POST',
        url: `/api/v1/dispositivos/${deviceId}/assign`,
        headers: {
          'x-test-actor': admin.username,
          'x-otp-code': VALID_OTP,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ canvasUserId: 80_900 }),
      });
      expect(r.statusCode).toBe(200);

      const verifyCall = calls.find((c) => c.url.includes('/v1/otps/verify'));
      expect(verifyCall).toBeDefined(); // destructive route must call /v1/otps/verify
      expect(verifyCall!.authorization).toMatch(
        new RegExp(`^HMAC backoffice-dispositivos \\d+ [a-f0-9]+$`),
      );
      // And NOT the default that the bug used to leak through.
      expect(verifyCall!.authorization).not.toMatch(/^HMAC quorum-backoffice /);
    } finally {
      await app.close();
    }
  }, 30_000);

  it('marbetes create signs the HMAC header with the configured OTP_SERVICE_NAME', async () => {
    const { app, calls } = await buildAppWithServiceName('backoffice-marbetes');
    try {
      const admin = await seedAdmin(pool);
      const code = `MRB-B7A-${Date.now()}`;

      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/marbetes',
        headers: {
          'x-test-actor': admin.username,
          'x-otp-code': VALID_OTP,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ code, notes: 'B7A propagation test' }),
      });
      expect(r.statusCode).toBe(201);

      const verifyCall = calls.find((c) => c.url.includes('/v1/otps/verify'));
      expect(verifyCall).toBeDefined(); // destructive route must call /v1/otps/verify
      expect(verifyCall!.authorization).toMatch(
        new RegExp(`^HMAC backoffice-marbetes \\d+ [a-f0-9]+$`),
      );
      expect(verifyCall!.authorization).not.toMatch(/^HMAC quorum-backoffice /);
    } finally {
      await app.close();
    }
  }, 30_000);
});
