/**
 * WU3a integration tests: full CRUD against real PG.
 *
 * Assumes scripts/dev-bootstrap.sh + npm run migrate have run so the
 * schema is in place and the dev test actor header is accepted.
 */
import { Pool } from 'pg';
import { migrate } from '../../src/migrations';
import path from 'node:path';
import { buildApp } from '../../src/app';

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

describe('marbetes routes (integration, real PG)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    // Clean slate
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
    await runMigrations(pool);
    app = await buildApp({ config: TEST_ENV });
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

  it('GET /api/v1/marbetes/counters returns zeros initially', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/marbetes/counters',
      headers: { 'x-test-actor': 'tester' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: 0, ko: 0 });
  });

  it('POST /api/v1/marbetes creates a marbete (assign later)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes',
      headers: { 'x-test-actor': 'tester', 'content-type': 'application/json' },
      payload: JSON.stringify({ code: 'ABC123-XYZ' }),
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { id: number; publicUid: string; status: string; maskedCode: string; student: unknown };
    expect(body.id).toBeGreaterThan(0);
    expect(body.publicUid).toMatch(/^m-[A-Z2-9]{4}$/);
    expect(body.status).toBe('active');
    expect(body.maskedCode).toMatch(/^.{1}\*\*\*.{2}$/);
    expect(body.student).toBeNull();
    expect(r.headers['location']).toBe(`/api/v1/marbetes/${body.id}`);
  });

  it('PATCH /api/v1/marbetes/:id assigns a student', async () => {
    const studentId = await seedStudent(99001, 'Ada Lovelace', 'ada@quorum.local');
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes',
      headers: { 'x-test-actor': 'tester', 'content-type': 'application/json' },
      payload: JSON.stringify({ code: 'ASSIGNED-CODE-1' }),
    });
    const created = create.json() as { id: number };

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/marbetes/${created.id}`,
      headers: { 'x-test-actor': 'tester', 'content-type': 'application/json' },
      payload: JSON.stringify({ assignedStudentId: studentId }),
    });
    expect(patch.statusCode).toBe(200);
    const body = patch.json() as { assignedStudentId: number; assignedAt: string | null; student: { fullName: string } | null };
    expect(body.assignedStudentId).toBe(studentId);
    expect(body.assignedAt).not.toBeNull();
    expect(body.student?.fullName).toBe('Ada Lovelace');
  });

  it('rejects assigning a second active marbete to the same student', async () => {
    const studentId = await seedStudent(99002, 'Alan Turing', 'alan@quorum.local');
    const m1 = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes',
      headers: { 'x-test-actor': 'tester', 'content-type': 'application/json' },
      payload: JSON.stringify({ code: 'TURING-1' }),
    });
    const first = m1.json() as { id: number };
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/marbetes/${first.id}`,
      headers: { 'x-test-actor': 'tester', 'content-type': 'application/json' },
      payload: JSON.stringify({ assignedStudentId: studentId }),
    });

    const m2 = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes',
      headers: { 'x-test-actor': 'tester', 'content-type': 'application/json' },
      payload: JSON.stringify({ code: 'TURING-2' }),
    });
    const second = m2.json() as { id: number };

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/marbetes/${second.id}`,
      headers: { 'x-test-actor': 'tester', 'content-type': 'application/json' },
      payload: JSON.stringify({ assignedStudentId: studentId }),
    });
    expect(patch.statusCode).toBe(500); // PG 23505 raised by repo -> mapped to internal
    const body = patch.json() as { code: string };
    expect(body.code).toBe('internal');
  });

  it('DELETE /api/v1/marbetes/:id soft-deletes with a reason', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes',
      headers: { 'x-test-actor': 'tester', 'content-type': 'application/json' },
      payload: JSON.stringify({ code: 'TO-DELETE-1' }),
    });
    const created = create.json() as { id: number };
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/marbetes/${created.id}`,
      headers: { 'x-test-actor': 'tester', 'content-type': 'application/json' },
      payload: JSON.stringify({ reason: 'broken lenticular code' }),
    });
    expect(del.statusCode).toBe(200);
    const body = del.json() as { status: string; deletedAt: string | null; deletionReason: string | null };
    expect(body.status).toBe('revoked');
    expect(body.deletedAt).not.toBeNull();
    expect(body.deletionReason).toBe('broken lenticular code');
  });

  it('counters reflect OK after an assigned marbete exists', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/marbetes/counters',
      headers: { 'x-test-actor': 'tester' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { ok: number; ko: number };
    expect(body.ok).toBeGreaterThanOrEqual(1);
  });

  it('rejects DELETE without a reason (Zod)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes',
      headers: { 'x-test-actor': 'tester', 'content-type': 'application/json' },
      payload: JSON.stringify({ code: 'NO-REASON-1' }),
    });
    const created = create.json() as { id: number };
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/marbetes/${created.id}`,
      headers: { 'x-test-actor': 'tester', 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(del.statusCode).toBe(400);
  });

  it('list with search filter returns matching marbete', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/marbetes?search=m-&limit=10',
      headers: { 'x-test-actor': 'tester' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { total: number; items: unknown[] };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
  });
});

async function runMigrations(pool: Pool): Promise<void> {
  const dir = path.resolve(__dirname, '..', '..', 'migrations');
  const r = await migrate({ pool, dir });
  if (r.applied.length > 0) {
    // eslint-disable-next-line no-console
    console.log('test applied migrations:', r.applied);
  }
}
