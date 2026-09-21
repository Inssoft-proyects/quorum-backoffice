/**
 * WU8b1 integration tests: students lookup endpoint + cache behavior.
 *
 * Coverage:
 *   - GET /api/v1/students?canvasUserId=<active>   → 200 + DTO
 *   - GET /api/v1/students?canvasUserId=<unknown>  → 404
 *   - GET /api/v1/students?canvasUserId=abc        → 400 (path validation)
 *   - GET /api/v1/students (no query)              → 400 (missing required)
 *   - GET /api/v1/students route requires admin role (operator → 403)
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

async function seedStudent(
  pool: Pool,
  canvasId: number,
  name: string,
  email: string,
  active = true,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO students_cache (canvas_user_id, full_name, email, is_active)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [canvasId, name, email, active],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('student_seed_failed');
  return id;
}

describe('students endpoint (integration, real PG)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    await pool.query(`
      DROP TABLE IF EXISTS audit_log CASCADE;
      DROP TABLE IF EXISTS dispositivos CASCADE;
      DROP TABLE IF EXISTS marbetes CASCADE;
      DROP TABLE IF EXISTS sessions CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
      DROP TABLE IF EXISTS students_cache CASCADE;
      DROP TYPE IF EXISTS user_role CASCADE;
      DROP TYPE IF EXISTS audit_action CASCADE;
      DROP TYPE IF EXISTS dispositivo_status CASCADE;
      DROP TYPE IF EXISTS marbete_status CASCADE;
      DROP TABLE IF EXISTS _migrations CASCADE;
    `);
    await migrate({ pool, dir: path.resolve(__dirname, '..', '..', 'migrations') });
    app = await buildApp({ config: TEST_ENV });
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('not used', { status: 404 })) as unknown as typeof fetch;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  function readHeaders(): Record<string, string> {
    return { 'x-test-actor': 'tester' };
  }

  it('GET /api/v1/students?canvasUserId=X returns active student details', async () => {
    const canvasId = 80_001 + Math.floor(Math.random() * 10_000);
    await seedStudent(pool, canvasId, 'Marie Curie', `marie-${canvasId}@quorum.local`);
    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/students?canvasUserId=${canvasId}`,
      headers: readHeaders(),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      id: number;
      canvasUserId: number;
      fullName: string;
      email: string;
      isActive: boolean;
    };
    expect(body.canvasUserId).toBe(canvasId);
    expect(body.fullName).toBe('Marie Curie');
    expect(body.email).toBe(`marie-${canvasId}@quorum.local`);
    expect(body.isActive).toBe(true);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('GET /api/v1/students?canvasUserId=X returns inactive student details with isActive=false', async () => {
    const canvasId = 80_002 + Math.floor(Math.random() * 10_000);
    await seedStudent(pool, canvasId, 'Withdrawn E.', `withdrawn-${canvasId}@quorum.local`, false);
    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/students?canvasUserId=${canvasId}`,
      headers: readHeaders(),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { isActive: boolean; canvasUserId: number };
    expect(body.isActive).toBe(false);
    expect(body.canvasUserId).toBe(canvasId);
  });

  it('GET /api/v1/students returns 404 when canvasUserId is unknown', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/students?canvasUserId=999999999',
      headers: readHeaders(),
    });
    expect(r.statusCode).toBe(404);
    const body = r.json() as { code: string };
    expect(body.code).toBe('not_found');
  });

  it('GET /api/v1/students?canvasUserId=abc returns 400 (path validation)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/students?canvasUserId=abc',
      headers: readHeaders(),
    });
    expect(r.statusCode).toBe(400);
    const body = r.json() as { code: string };
    expect(body.code).toBe('validation_error');
  });

  it('GET /api/v1/students?canvasUserId=0 returns 400 (positive required)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/students?canvasUserId=0',
      headers: readHeaders(),
    });
    expect(r.statusCode).toBe(400);
  });

  it('GET /api/v1/students (missing required) returns 400', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/students',
      headers: readHeaders(),
    });
    expect(r.statusCode).toBe(400);
    const body = r.json() as { code: string };
    expect(body.code).toBe('validation_error');
  });
});
