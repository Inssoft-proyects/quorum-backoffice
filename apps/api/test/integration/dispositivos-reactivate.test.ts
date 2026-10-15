/**
 * Integration tests for the dispositivos logical-delete model:
 *   - POST /api/v1/dispositivos/:id/reactivate (un-revoke)
 *   - POST /api/v1/dispositivos upsert: re-registering a revoked serial
 *     reactivates the SAME row instead of inserting a new one.
 *
 * Mirrors dispositivos.test.ts: real Fastify app (buildApp + inject) against
 * a real PostgreSQL test DB, OTP mocked at the HTTP boundary (global fetch).
 * `x-test-actor` is the NODE_ENV=test virtual-admin shim used by the existing
 * CRUD tests.
 */
import { Pool } from 'pg';
import path from 'node:path';
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
};

const VALID_OTP = '123456';
const MOCK_OTP_ID = 'otp-test-reactivate';

function makeOtpFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/otps/verify')) {
      const raw = init?.body ? String(init.body) : '{}';
      const parsed = JSON.parse(raw) as { token?: string; code?: string };
      const code = parsed.token ?? parsed.code;
      if (code === VALID_OTP) {
        return new Response(JSON.stringify({ id: MOCK_OTP_ID, valid: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'verify_rejected' }), { status: 409 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

function happyHeaders(): Record<string, string> {
  return {
    'x-test-actor': 'tester',
    'x-otp-code': VALID_OTP,
    'content-type': 'application/json',
  };
}

async function createSerial(
  app: Awaited<ReturnType<typeof buildApp>>,
  serial: string,
  brand?: string,
  model?: string,
): Promise<number> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/dispositivos',
    headers: happyHeaders(),
    payload: JSON.stringify({ serialNumber: serial, brand, model }),
  });
  expect(r.statusCode).toBe(201);
  return (r.json() as { id: number }).id;
}

async function revokeSerial(
  app: Awaited<ReturnType<typeof buildApp>>,
  id: number,
  reason = 'test revoke',
): Promise<void> {
  const r = await app.inject({
    method: 'DELETE',
    url: `/api/v1/dispositivos/${id}`,
    headers: happyHeaders(),
    payload: JSON.stringify({ reason }),
  });
  expect(r.statusCode).toBe(200);
}

describe('dispositivos reactivate + create-upsert (integration, real PG)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    await pool.query(`
      DROP TABLE IF EXISTS audit_log CASCADE;
      DROP TABLE IF EXISTS dispositivos CASCADE;
      DROP TABLE IF EXISTS marbetes CASCADE;
      DROP TABLE IF EXISTS students_cache CASCADE;
      DROP TYPE IF EXISTS audit_action CASCADE;
      DROP TYPE IF EXISTS dispositivo_status CASCADE;
      DROP TYPE IF EXISTS marbete_status CASCADE;
      DROP TABLE IF EXISTS _migrations CASCADE;
    `);
    await migrate({ pool, dir: path.resolve(__dirname, '..', '..', 'migrations') });
    app = await buildApp({ config: TEST_ENV });
    (globalThis as { fetch: typeof fetch }).fetch = makeOtpFetch();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function auditCount(action: string): Promise<number> {
    const r = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log WHERE action = $1 AND otp_id = $2`,
      [action, MOCK_OTP_ID],
    );
    return Number(r.rows[0]?.count ?? '0');
  }

  it('POST /:id/reactivate un-revokes a revoked device, keeping the same id', async () => {
    const id = await createSerial(app, 'SN-REACT-1', 'Apple', 'iPad');
    await revokeSerial(app, id);

    const before = await auditCount('dispositivo.reactivate');
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${id}/reactivate`,
      headers: happyHeaders(),
      payload: JSON.stringify({}),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { id: number; status: string; revokedAt: string | null; revokedReason: string | null };
    expect(body.id).toBe(id);
    expect(body.status).toBe('active');
    expect(body.revokedAt).toBeNull();
    expect(body.revokedReason).toBeNull();
    expect(await auditCount('dispositivo.reactivate')).toBe(before + 1);
  });

  it('POST /:id/reactivate returns 404 for an unknown device', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/dispositivos/999999/reactivate',
      headers: happyHeaders(),
      payload: JSON.stringify({}),
    });
    expect(r.statusCode).toBe(404);
  });

  it('POST /:id/reactivate returns 409 when the device is already active', async () => {
    const id = await createSerial(app, 'SN-REACT-ACTIVE');
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${id}/reactivate`,
      headers: happyHeaders(),
      payload: JSON.stringify({}),
    });
    expect(r.statusCode).toBe(409);
  });

  it('POST /:id/reactivate requires a valid OTP', async () => {
    const id = await createSerial(app, 'SN-REACT-OTP');
    await revokeSerial(app, id);

    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${id}/reactivate`,
      headers: { 'x-test-actor': 'tester', 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(missing.statusCode).toBe(401);
    expect((missing.json() as { code: string }).code).toBe('otp_required');

    const bad = await app.inject({
      method: 'POST',
      url: `/api/v1/dispositivos/${id}/reactivate`,
      headers: { 'x-test-actor': 'tester', 'x-otp-code': '000000', 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(bad.statusCode).toBe(401);
    expect((bad.json() as { code: string }).code).toBe('otp_invalid');
  });

  it('POST /dispositivos re-registers a revoked serial over the same row', async () => {
    const id = await createSerial(app, 'SN-REACT-UPSERT', 'Old', 'OldModel');
    await revokeSerial(app, id);

    const before = await auditCount('dispositivo.reactivate');
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/dispositivos',
      headers: happyHeaders(),
      payload: JSON.stringify({ serialNumber: 'SN-REACT-UPSERT', brand: 'New', model: 'NewModel' }),
    });
    // The route keeps its single 201 contract for POST /dispositivos
    // (insert OR reactivate); what changes is that the SAME row is reused.
    expect(r.statusCode).toBe(201);
    const body = r.json() as { id: number; serialNumber: string; status: string; brand: string; model: string };
    expect(body.id).toBe(id);
    expect(body.serialNumber).toBe('SN-REACT-UPSERT');
    expect(body.status).toBe('active');
    expect(body.brand).toBe('New');
    expect(body.model).toBe('NewModel');
    expect(await auditCount('dispositivo.reactivate')).toBe(before + 1);

    // The same row is reused, so there is still exactly one row for the serial.
    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM dispositivos WHERE serial_number = 'SN-REACT-UPSERT'`,
    );
    expect(Number(count.rows[0]?.count ?? '0')).toBe(1);
  });

  it('POST /dispositivos still returns 409 for an active serial', async () => {
    await createSerial(app, 'SN-REACT-DUP');
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/dispositivos',
      headers: happyHeaders(),
      payload: JSON.stringify({ serialNumber: 'SN-REACT-DUP' }),
    });
    expect(r.statusCode).toBe(409);
  });
});
