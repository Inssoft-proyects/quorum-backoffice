/**
 * Integration tests for /api/v1/matriculas/* endpoints (WU v3).
 *
 * Convention (matches apps/api/test/integration/marbetes.test.ts):
 *   - real PostgreSQL connection (DATABASE_URL_TEST)
 *   - migrations run from scratch via the custom runner
 *   - mocked OTP + Canvas clients via the global fetch shim
 *
 * The parent task explicitly says: "write them to the existing
 * convention but DO NOT run them (no reachable test DB on this
 * host); report as written-not-run". So this is a written-only
 * artifact that future test runs (in CI with a reachable DB) will
 * exercise end-to-end. The shape mirrors marbetes.test.ts so a
 * reviewer can compare both files side-by-side.
 *
 * Coverage targets:
 *   - GET  /api/v1/matriculas             (list, paginated, filter)
 *   - GET  /api/v1/matriculas/counters    (header aggregates)
 *   - POST /api/v1/matriculas/assign      (bulk, with OTP + audit)
 *   - POST /api/v1/matriculas/unassign    (single, with OTP + audit)
 *   - POST /api/v1/matriculas/sync        (Canvas → cache, mocked)
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
  OTP_SERVICE_NAME: 'quorum-backoffice',
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

const VALID_OTP = '123456';
const MOCK_OTP_ID = 'otp-matriculas-test';

function makeOtpFetch(behaviour: (body: unknown) => { status: number; body: unknown }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/otps/verify')) {
      const raw = init?.body ? String(init.body) : '{}';
      const parsed = JSON.parse(raw) as { code?: string };
      if (parsed.code === '999999') {
        return new Response(JSON.stringify({ error: 'invalid' }), { status: 401 });
      }
      const r = behaviour(JSON.parse(raw));
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

function makeCanvasFetch(pages: unknown[]): typeof fetch {
  let pageIndex = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/students')) {
      if (pageIndex >= pages.length) {
        return new Response(JSON.stringify({ total: 0, items: [] }), { status: 200 });
      }
      const next = pages[pageIndex++];
      return new Response(JSON.stringify(next), { status: 200 });
    }
    if (url.includes('/v1/otps/verify')) {
      const raw = init?.body ? String(init.body) : '{}';
      const parsed = JSON.parse(raw) as { code?: string };
      if (parsed.code === VALID_OTP) {
        return new Response(JSON.stringify({ id: MOCK_OTP_ID }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'invalid' }), { status: 401 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('matriculas routes (integration, real PG)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    await pool.query(`
      DROP TABLE IF EXISTS audit_log CASCADE;
      DROP TABLE IF EXISTS otp_grants CASCADE;
      DROP TABLE IF EXISTS dispositivos CASCADE;
      DROP TABLE IF EXISTS marbetes CASCADE;
      DROP TABLE IF EXISTS students_cache CASCADE;
      DROP TABLE IF EXISTS sessions CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
      DROP TYPE IF EXISTS audit_action CASCADE;
      DROP TYPE IF EXISTS dispositivo_status CASCADE;
      DROP TYPE IF EXISTS marbete_status CASCADE;
      DROP TYPE IF EXISTS user_role CASCADE;
      DROP TABLE IF EXISTS _migrations CASCADE;
    `);
    await migrate({ pool, dir: path.resolve(__dirname, '..', '..', 'migrations') });
    app = await buildApp({ config: TEST_ENV });
    const fetchMock = makeOtpFetch((body) => {
      const code = (body as { code?: string }).code;
      if (code === VALID_OTP) return { status: 200, body: { id: MOCK_OTP_ID } };
      return { status: 401, body: { error: 'invalid' } };
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function seedStudent(
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
    if (!id) throw new Error('seed_failed');
    return id;
  }

  async function seedMarbete(publicUid: string, assignedTo: number | null = null): Promise<number> {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO marbetes (public_uid, code_hash, status, assigned_student_id, created_by)
       VALUES ($1, 'a'.repeat(64), 'active', $2, 'seed') RETURNING id`,
      [publicUid, assignedTo],
    );
    const id = r.rows[0]?.id;
    if (!id) throw new Error('marbete_seed_failed');
    return id;
  }

  function adminHeaders(): Record<string, string> {
    return {
      'x-test-actor': 'tester',
      'x-otp-code': VALID_OTP,
      'content-type': 'application/json',
    };
  }

  function sessionHeaders(): Record<string, string> {
    return { 'x-test-actor': 'tester' };
  }

  it('GET /api/v1/matriculas returns a paginated list with embedded marbete', async () => {
    const c1 = 90_001;
    const c2 = 90_002;
    const _student1 = await seedStudent(c1, 'Alice A', `alice-${c1}@x`);
    const student2 = await seedStudent(c2, 'Bob B', `bob-${c2}@x`);
    const mid = await seedMarbete('m-LIST0001', student2);

    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/matriculas?limit=10&offset=0',
      headers: sessionHeaders(),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      total: number;
      items: { canvasUserId: number; marbete: { id: number; publicUid: string } | null }[];
    };
    expect(body.total).toBeGreaterThanOrEqual(2);
    const found1 = body.items.find((i) => i.canvasUserId === c1);
    const found2 = body.items.find((i) => i.canvasUserId === c2);
    expect(found1?.marbete).toBeNull();
    expect(found2?.marbete?.id).toBe(mid);
  });

  it('GET /api/v1/matriculas/counters returns total / assigned / unassigned / availableMarbetes', async () => {
    await seedStudent(90_010, 'Carol C', `carol-90_010@x`);
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/matriculas/counters',
      headers: sessionHeaders(),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      total: number;
      assigned: number;
      unassigned: number;
      availableMarbetes: number;
    };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.assigned).toBeGreaterThanOrEqual(1);
    expect(body.unassigned).toBeGreaterThanOrEqual(0);
    expect(body.availableMarbetes).toBeGreaterThanOrEqual(0);
  });

  it('POST /api/v1/matriculas/assign → 200, audit row written with action=marbete.assign_bulk', async () => {
    const c = 90_100;
    await seedStudent(c, 'Diana D', `diana-${c}@x`);
    const mid = await seedMarbete('m-ASSIGN0001');
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/matriculas/assign',
      headers: adminHeaders(),
      payload: JSON.stringify({
        pairs: [{ canvasUserId: c, marbeteId: mid }],
      }),
    });
    expect(r.statusCode).toBe(200);
    const audit = await pool.query<{ action: string; entity_type: string | null }>(
      `SELECT action, entity_type FROM audit_log
        WHERE action = 'marbete.assign_bulk'
        ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.action).toBe('marbete.assign_bulk');
    expect(audit.rows[0]?.entity_type).toBe('matricula');
  });

  it('POST /api/v1/matriculas/assign with inactive student → 422 student_not_active', async () => {
    const c = 90_101;
    await seedStudent(c, 'Edward E', `edward-${c}@x`, false);
    const mid = await seedMarbete('m-ASSIGN0002');
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/matriculas/assign',
      headers: adminHeaders(),
      payload: JSON.stringify({ pairs: [{ canvasUserId: c, marbeteId: mid }] }),
    });
    expect(r.statusCode).toBe(422);
    expect((r.json() as { code: string }).code).toBe('student_not_active');
  });

  it('POST /api/v1/matriculas/unassign → 200, clears assignment + audit', async () => {
    const c = 90_200;
    const studentId = await seedStudent(c, 'Fiona F', `fiona-${c}@x`);
    const mid = await seedMarbete('m-UNASSIGN0001', studentId);
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/matriculas/unassign',
      headers: adminHeaders(),
      payload: JSON.stringify({
        marbeteId: mid,
        reason: 'returned to inventory',
        comentario: 'good condition',
      }),
    });
    expect(r.statusCode).toBe(200);
    const updated = await pool.query<{ assigned_student_id: number | null; assigned_by: string | null }>(
      `SELECT assigned_student_id, assigned_by FROM marbetes WHERE id = $1`,
      [mid],
    );
    expect(updated.rows[0]?.assigned_student_id).toBeNull();
    expect(updated.rows[0]?.assigned_by).toBeNull();
    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_log
        WHERE entity_id = (SELECT public_uid FROM marbetes WHERE id = $1)
        ORDER BY occurred_at DESC LIMIT 1`,
      [mid],
    );
    expect(audit.rows[0]?.action).toBe('marbete.unassign');
  });

  it('POST /api/v1/matriculas/sync → 200, upserts students_cache (Canvas mocked)', async () => {
    // Re-wire fetch so the sync endpoint hits our Canvas mock.
    const canvasPages = [
      {
        total: 3,
        items: [
          { id: 1, canvas_user_id: 80_001, full_name: 'Sync A', email: 'sa@x' },
          { id: 2, canvas_user_id: 80_002, full_name: 'Sync B', email: 'sb@x' },
          { id: 3, canvas_user_id: 80_003, full_name: 'Sync C', email: 'sc@x' },
        ],
      },
    ];
    (globalThis as { fetch: typeof fetch }).fetch = makeCanvasFetch(canvasPages);
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/matriculas/sync',
      headers: { 'x-test-actor': 'tester', 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      total: number;
      created: number;
      updated: number;
      unchanged: number;
      durationMs: number;
    };
    expect(body.total).toBe(3);
    expect(body.created + body.updated + body.unchanged).toBe(3);
    expect(body.durationMs).toBeGreaterThanOrEqual(0);

    // Restore OTP mock for subsequent tests.
    (globalThis as { fetch: typeof fetch }).fetch = makeOtpFetch((body) => {
      const code = (body as { code?: string }).code;
      if (code === VALID_OTP) return { status: 200, body: { id: MOCK_OTP_ID } };
      return { status: 401, body: { error: 'invalid' } };
    });
  });
});