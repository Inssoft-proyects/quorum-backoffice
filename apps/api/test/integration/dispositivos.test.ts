/**
 * WU4 integration tests: dispositivos CRUD + OTP guard + audit writes.
 *
 * Reuses the same OTP fetch-mock pattern as marbetes.test.ts (global fetch).
 * The test database has the 4 migrations applied; the dispositivos table is
 * seeded/truncated per test via direct SQL to keep tests independent.
 *
 * Coverage targets:
 *  - happy path: create, list, get, patch, delete with valid OTP
 *  - audit writes for each destructive action
 *  - OTP rejection: missing header, invalid code
 *  - validation: missing serial on create, bad id on path params
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
const MOCK_OTP_ID = 'otp-test-fixed-dispositivo';

function makeOtpFetch(
  behaviour: (body: { code?: string }) => { status: number; body: unknown },
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/otps/verify')) {
      const raw = init?.body ? String(init.body) : '{}';
      const parsed = JSON.parse(raw) as { code?: string };
      const r = behaviour(parsed);
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('dispositivos routes with mocked OTP happy path (integration, real PG)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    // Recreate schema from scratch so each test file is independent.
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
    const fetchMock = makeOtpFetch((body) => {
      if (body.code === VALID_OTP) return { status: 200, body: { id: MOCK_OTP_ID } };
      return { status: 401, body: { error: 'invalid' } };
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  function happyHeaders(): Record<string, string> {
    return {
      'x-test-actor': 'tester',
      'x-otp-code': VALID_OTP,
      'content-type': 'application/json',
    };
  }

  async function auditCount(action: string): Promise<number> {
    const r = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log WHERE action = $1 AND otp_id = $2`,
      [action, MOCK_OTP_ID],
    );
    return Number(r.rows[0]?.count ?? '0');
  }

  it('POST /api/v1/dispositivos creates with valid OTP and writes audit', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/dispositivos',
      headers: happyHeaders(),
      payload: JSON.stringify({ serialNumber: 'SN-WU4-CREATE-1', brand: 'Apple', model: 'iPad Pro' }),
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { id: number; serialNumber: string; status: string };
    expect(body.id).toBeGreaterThan(0);
    expect(body.serialNumber).toBe('SN-WU4-CREATE-1');
    expect(body.status).toBe('active');
    expect(await auditCount('dispositivo.create')).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/v1/dispositivos lists and filters by status + search', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/dispositivos?status=active&search=CREATE',
      headers: { 'x-test-actor': 'tester' },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { total: number; items: Array<{ serialNumber: string }> };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.items.some((i) => i.serialNumber === 'SN-WU4-CREATE-1')).toBe(true);
  });

  it('GET /api/v1/dispositivos/:id returns detail (no OTP needed)', async () => {
    const c = await app.inject({
      method: 'POST',
      url: '/api/v1/dispositivos',
      headers: happyHeaders(),
      payload: JSON.stringify({ serialNumber: 'SN-WU4-GET-1', brand: 'Samsung' }),
    });
    const id = (c.json() as { id: number }).id;
    const g = await app.inject({
      method: 'GET',
      url: `/api/v1/dispositivos/${id}`,
      headers: { 'x-test-actor': 'tester' },
    });
    expect(g.statusCode).toBe(200);
    const detail = g.json() as { id: number; serialNumber: string; brand: string };
    expect(detail.id).toBe(id);
    expect(detail.serialNumber).toBe('SN-WU4-GET-1');
    expect(detail.brand).toBe('Samsung');
  });

  it('PATCH /api/v1/dispositivos/:id updates brand/model with valid OTP and writes audit', async () => {
    const c = await app.inject({
      method: 'POST',
      url: '/api/v1/dispositivos',
      headers: happyHeaders(),
      payload: JSON.stringify({ serialNumber: 'SN-WU4-PATCH-1', brand: 'Apple', model: 'iPad' }),
    });
    const id = (c.json() as { id: number }).id;
    const before = await auditCount('dispositivo.update');
    const p = await app.inject({
      method: 'PATCH',
      url: `/api/v1/dispositivos/${id}`,
      headers: happyHeaders(),
      payload: JSON.stringify({ model: 'iPad Air' }),
    });
    expect(p.statusCode).toBe(200);
    const detail = p.json() as { brand: string; model: string };
    expect(detail.brand).toBe('Apple');
    expect(detail.model).toBe('iPad Air');
    expect(await auditCount('dispositivo.update')).toBe(before + 1);
  });

  it('DELETE /api/v1/dispositivos/:id soft-revokes with reason and writes audit (action=dispositivo.revoke)', async () => {
    const c = await app.inject({
      method: 'POST',
      url: '/api/v1/dispositivos',
      headers: happyHeaders(),
      payload: JSON.stringify({ serialNumber: 'SN-WU4-REVOKE-1' }),
    });
    const id = (c.json() as { id: number }).id;
    const d = await app.inject({
      method: 'DELETE',
      url: `/api/v1/dispositivos/${id}`,
      headers: happyHeaders(),
      payload: JSON.stringify({ reason: 'stolen device' }),
    });
    expect(d.statusCode).toBe(200);
    const body = d.json() as { status: string; revokedReason: string | null };
    expect(body.status).toBe('revoked');
    expect(body.revokedReason).toBe('stolen device');

    // Subsequent DELETE must fail (already revoked → conflict).
    const d2 = await app.inject({
      method: 'DELETE',
      url: `/api/v1/dispositivos/${id}`,
      headers: happyHeaders(),
      payload: JSON.stringify({ reason: 'already revoked' }),
    });
    expect(d2.statusCode).toBe(409);
    expect(await auditCount('dispositivo.revoke')).toBeGreaterThanOrEqual(1);
  });
});

describe('dispositivos routes with rejected OTP (integration)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    await migrate({ pool, dir: path.resolve(__dirname, '..', '..', 'migrations') });
    app = await buildApp({ config: TEST_ENV });
    // Every OTP verify returns 401.
    const fetchMock = makeOtpFetch(() => ({ status: 401, body: { error: 'invalid' } }));
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('POST returns 401 when OTP header is missing', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/dispositivos',
      headers: { 'x-test-actor': 'tester', 'content-type': 'application/json' },
      payload: JSON.stringify({ serialNumber: 'NO-OTP-1' }),
    });
    expect(r.statusCode).toBe(401);
    const body = r.json() as { code: string };
    expect(body.code).toBe('otp_required');
  });

  it('POST returns 401 when OTP code is rejected by service', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/dispositivos',
      headers: {
        'x-test-actor': 'tester',
        'x-otp-code': '000000',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ serialNumber: 'BAD-OTP-1' }),
    });
    expect(r.statusCode).toBe(401);
    const body = r.json() as { code: string };
    expect(body.code).toBe('otp_invalid');
  });

  it('PATCH returns 401 when OTP is missing', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/dispositivos/1',
      headers: { 'x-test-actor': 'tester', 'content-type': 'application/json' },
      payload: JSON.stringify({ model: 'X' }),
    });
    expect(r.statusCode).toBe(401);
  });

  it('DELETE returns 401 when OTP is missing', async () => {
    const r = await app.inject({
      method: 'DELETE',
      url: '/api/v1/dispositivos/1',
      headers: { 'x-test-actor': 'tester', 'content-type': 'application/json' },
      payload: JSON.stringify({ reason: 'no otp' }),
    });
    expect(r.statusCode).toBe(401);
  });

  it('POST returns 400 when serialNumber is missing', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/dispositivos',
      headers: {
        'x-test-actor': 'tester',
        'x-otp-code': VALID_OTP,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ brand: 'Apple' }),
    });
    expect(r.statusCode).toBe(400);
  });

  it('GET /api/v1/dispositivos/:id with non-numeric id returns 400', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/dispositivos/abc',
      headers: { 'x-test-actor': 'tester' },
    });
    expect(r.statusCode).toBe(400);
  });
});