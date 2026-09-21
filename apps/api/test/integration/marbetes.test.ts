/**
 * WU3b integration tests: full CRUD with mocked OTP service + audit writes.
 *
 * The OTP service is mocked at the fetch level: any request to
 * OTP_SERVICE_URL is intercepted and returns ok=true with a deterministic
 * otpId. A separate suite verifies OTP rejection paths.
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
const MOCK_OTP_ID = 'otp-test-fixed';

function makeOtpFetch(behaviour: (body: unknown) => { status: number; body: unknown }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/otps/verify')) {
      const raw = init?.body ? String(init.body) : '{}';
      const parsed = JSON.parse(raw) as { code?: string };
      // Reject if code is the explicitly invalid one.
      if (parsed.code === '999999') {
        return new Response(JSON.stringify({ error: 'invalid' }), { status: 401 });
      }
      const r = behaviour(JSON.parse(raw));
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('marbetes routes with mocked OTP happy path (integration, real PG)', () => {
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

    const fetchMock = makeOtpFetch((body) => {
      const code = (body as { code?: string }).code;
      if (code === VALID_OTP) return { status: 200, body: { id: MOCK_OTP_ID } };
      return { status: 401, body: { error: 'invalid' } };
    });
    app = await buildApp({
      config: TEST_ENV,
      // Inject the mock fetch via global; OtpClient falls back to global fetch.
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function seedStudent(canvasId: number, name: string, email: string): Promise<number> {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO students_cache (canvas_user_id, full_name, email) VALUES ($1, $2, $3) RETURNING id`,
      [canvasId, name, email],
    );
    const id = r.rows[0]?.id;
    if (!id) throw new Error('seed_failed');
    return id;
  }

  function happyHeaders(): Record<string, string> {
    return {
      'x-test-actor': 'tester',
      'x-otp-code': VALID_OTP,
      'content-type': 'application/json',
    };
  }

  it('POST /api/v1/marbetes creates with valid OTP and writes audit', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes',
      headers: happyHeaders(),
      payload: JSON.stringify({ code: 'WITH-OTP-CODE-1' }),
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { id: number; publicUid: string };
    expect(body.id).toBeGreaterThan(0);

    // Audit entry exists with the captured otp_id.
    const audit = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log WHERE action = 'marbete.create' AND otp_id = $1`,
      [MOCK_OTP_ID],
    );
    expect(Number(audit.rows[0]?.count)).toBeGreaterThanOrEqual(1);
  });

  it('PATCH /api/v1/marbetes/:id assigns with valid OTP and writes audit (action = marbete.assign)', async () => {
    const studentId = await seedStudent(99101, 'Grace Hopper', 'grace@quorum.local');
    const c = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes',
      headers: happyHeaders(),
      payload: JSON.stringify({ code: 'GRACE-MARBETE-1' }),
    });
    const cid = (c.json() as { id: number }).id;
    const p = await app.inject({
      method: 'PATCH',
      url: `/api/v1/marbetes/${cid}`,
      headers: happyHeaders(),
      payload: JSON.stringify({ assignedStudentId: studentId }),
    });
    expect(p.statusCode).toBe(200);

    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [(c.json() as { publicUid: string }).publicUid],
    );
    expect(audit.rows[0]?.action).toBe('marbete.assign');
  });

  it('DELETE /api/v1/marbetes/:id soft-deletes with valid OTP and writes audit (action = marbete.delete)', async () => {
    const c = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes',
      headers: happyHeaders(),
      payload: JSON.stringify({ code: 'TO-DELETE-WITH-OTP' }),
    });
    const cid = (c.json() as { id: number; publicUid: string }).id;
    const publicUid = (c.json() as { publicUid: string }).publicUid;
    const d = await app.inject({
      method: 'DELETE',
      url: `/api/v1/marbetes/${cid}`,
      headers: happyHeaders(),
      payload: JSON.stringify({ reason: 'lost in transit' }),
    });
    expect(d.statusCode).toBe(200);

    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [publicUid],
    );
    expect(audit.rows[0]?.action).toBe('marbete.delete');
  });

  it('GET routes do NOT require OTP', async () => {
    const counters = await app.inject({
      method: 'GET',
      url: '/api/v1/marbetes/counters',
      headers: { 'x-test-actor': 'tester' },
    });
    expect(counters.statusCode).toBe(200);
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/marbetes',
      headers: { 'x-test-actor': 'tester' },
    });
    expect(list.statusCode).toBe(200);
  });
});

describe('marbetes routes with rejected OTP (integration)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    await migrate({ pool, dir: path.resolve(__dirname, '..', '..', 'migrations') });
    app = await buildApp({ config: TEST_ENV });
    const fetchMock = makeOtpFetch(() => ({ status: 401, body: { error: 'invalid' } }));
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('POST returns 401 when OTP is invalid', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes',
      headers: {
        'x-test-actor': 'tester',
        'x-otp-code': '999999',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ code: 'INVALID-OTP-1' }),
    });
    expect(r.statusCode).toBe(401);
    const body = r.json() as { code: string };
    expect(body.code).toBe('otp_invalid');
  });

  it('POST returns 401 when OTP header is missing', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes',
      headers: { 'x-test-actor': 'tester', 'content-type': 'application/json' },
      payload: JSON.stringify({ code: 'NO-OTP-HEADER-1' }),
    });
    expect(r.statusCode).toBe(401);
    const body = r.json() as { code: string };
    expect(body.code).toBe('otp_required');
  });

  it('DELETE returns 401 when OTP is missing', async () => {
    const r = await app.inject({
      method: 'DELETE',
      url: '/api/v1/marbetes/1',
      headers: { 'x-test-actor': 'tester', 'content-type': 'application/json' },
      payload: JSON.stringify({ reason: 'no otp' }),
    });
    expect(r.statusCode).toBe(401);
  });
});
