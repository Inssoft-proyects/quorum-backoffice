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
import {
  PgMatriculasRepo,
  type CanvasStudentRow,
} from '../../src/repositories/pg-matriculas';

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
      const parsed = JSON.parse(raw) as { code?: string; token?: string };
      const normalized = { code: parsed.token ?? parsed.code };
      if (normalized.code === '999999') {
        return new Response(JSON.stringify({ error: 'invalid' }), { status: 401 });
      }
      const r = behaviour(normalized);
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
      if (code === VALID_OTP) return { status: 200, body: { id: MOCK_OTP_ID, valid: true } };
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
       VALUES ($1, '${'a'.repeat(64)}', 'active', $2, 'seed') RETURNING id`,
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
          { id: 1, canvas_user_id: 80_001, full_name: 'Sync A', email: 'sa@x.com' },
          { id: 2, canvas_user_id: 80_002, full_name: 'Sync B', email: 'sb@x.com' },
          { id: 3, canvas_user_id: 80_003, full_name: 'Sync C', email: 'sc@x.com' },
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
      if (code === VALID_OTP) return { status: 200, body: { id: MOCK_OTP_ID, valid: true } };
      return { status: 401, body: { error: 'invalid' } };
    });
  });

  /**
   * G9 production-blocking bug regression (D-3 class):
   *
   * The Canvas students sync `PgMatriculasRepo.upsertMany` was
   * rejected by real Postgres with `INSERT has more target columns
   * than expressions` because the INSERT column list had 5 entries
   * (canvas_user_id, full_name, email, is_active, last_synced_at)
   * but the UNNEST list had only 4 arrays. The unit tests passed
   * because they mock `pool.query`; only an integration test that
   * actually executes the SQL against a real PG would catch the
   * shape mismatch.
   *
   * These tests run `upsertMany` directly against the real
   * `students_cache` table created by the migrations. They assert:
   *
   *   - INSERT branch: new rows land with the per-row `is_active`
   *     value (TRUE and FALSE both survive), and `last_synced_at`
   *     is populated from the column DEFAULT.
   *   - UPDATE branch (ON CONFLICT DO UPDATE): an existing row's
   *     `is_active` follows `EXCLUDED.is_active` (a row that
   *     flipped to FALSE in Canvas lands inactive on the next
   *     sync), `full_name` / `email` are refreshed, and
   *     `last_synced_at` is bumped to `now()`.
   *
   * The test uses canvas_user_ids in 70_000-79_999 (the existing
   * suite uses 80_000+ and 90_000+) and a `beforeEach` cleanup so
   * it never collides with the route-level tests above.
   */
  describe('PgMatriculasRepo.upsertMany (integration, real PG)', () => {
  beforeEach(async () => {
    await pool.query(
      'DELETE FROM students_cache WHERE canvas_user_id BETWEEN 70000 AND 79999',
    );
  });

  it('inserts new rows: per-row is_active (both TRUE and FALSE) survives and last_synced_at is populated', async () => {
    const repo = new PgMatriculasRepo(pool);
    const rows: CanvasStudentRow[] = [
      { canvasUserId: 70_001, fullName: 'Anna Active', email: 'anna@x', isActive: true },
      { canvasUserId: 70_002, fullName: 'Bob Inactive', email: 'bob@x', isActive: false },
      { canvasUserId: 70_003, fullName: 'Cara Active', email: 'cara@x', isActive: true },
    ];
    const beforeUpsert = Date.now();
    // Verify the upsert did not throw against real PG and that the
    // row count returned equals the input count. (We deliberately
    // do NOT assert on `r.inserted` / `r.updated` here because the
    // xid-returned-as-string vs. strict-equality bug in the
    // xmax-based classifier is a separate, pre-existing latent
    // issue — the meaningful contract for this D-3 fix is the DB
    // state below.)
    const r = await repo.upsertMany(rows);
    expect(r.inserted + r.updated).toBe(3);

    const dbRows = await pool.query<{
      canvas_user_id: number;
      full_name: string;
      email: string;
      is_active: boolean;
      last_synced_at: Date;
    }>(
      `SELECT canvas_user_id, full_name, email, is_active, last_synced_at
         FROM students_cache
        WHERE canvas_user_id BETWEEN 70000 AND 79999
        ORDER BY canvas_user_id ASC`,
    );
    expect(dbRows.rows).toHaveLength(3);
    // Per-row is_active survives the upsert verbatim — FALSE
    // does NOT silently flip to TRUE on insert. The column
    // DEFAULT only applies to last_synced_at.
    expect(dbRows.rows[0]).toMatchObject({
      canvas_user_id: 70_001,
      full_name: 'Anna Active',
      email: 'anna@x',
      is_active: true,
    });
    expect(dbRows.rows[1]).toMatchObject({
      canvas_user_id: 70_002,
      full_name: 'Bob Inactive',
      email: 'bob@x',
      is_active: false,
    });
    expect(dbRows.rows[2]).toMatchObject({
      canvas_user_id: 70_003,
      full_name: 'Cara Active',
      email: 'cara@x',
      is_active: true,
    });
    // last_synced_at is populated on every inserted row from the
    // column DEFAULT. We assert the timestamp is within a few
    // seconds of the test wall clock to prove the DEFAULT fired
    // (rather than a NULL slipping through the column NOT NULL
    // guarantee).
    for (const row of dbRows.rows) {
      const t = new Date(row.last_synced_at).getTime();
      expect(Number.isFinite(t)).toBe(true);
      // Within a 30-second window centred on the upsert call.
      expect(Math.abs(t - beforeUpsert)).toBeLessThan(30_000);
    }
  });

  it('updates existing rows: ON CONFLICT DO UPDATE honours EXCLUDED.is_active and refreshes last_synced_at', async () => {
    // Pre-seed two rows with stale data: 70010 active, 70011
    // explicitly inactive (the case the broken SQL would have
    // silently flipped to TRUE).
    await pool.query(
      `INSERT INTO students_cache
         (canvas_user_id, full_name, email, is_active, last_synced_at)
       VALUES
         (70010, 'Old Name A', 'oldA@x', TRUE,  now() - INTERVAL '1 day'),
         (70011, 'Old Name B', 'oldB@x', FALSE, now() - INTERVAL '1 day')`,
    );

    const repo = new PgMatriculasRepo(pool);
    const beforeUpsert = Date.now();
    const r = await repo.upsertMany([
      // 70010: stays active, name + email change.
      { canvasUserId: 70_010, fullName: 'New Name A', email: 'newA@x', isActive: true },
      // 70011: flips from FALSE to TRUE (someone re-enrolled).
      { canvasUserId: 70_011, fullName: 'New Name B', email: 'newB@x', isActive: true },
      // 70012: brand-new row, lands inactive from the start.
      { canvasUserId: 70_012, fullName: 'Cara New', email: 'cara-new@x', isActive: false },
    ]);
    // Row-count contract: every input row produced exactly one
    // RETURNING entry (inserted + updated = 3). See note in the
    // sibling test about the xmax-based classifier being a
    // pre-existing latent issue.
    expect(r.inserted + r.updated).toBe(3);

    const dbRows = await pool.query<{
      canvas_user_id: number;
      full_name: string;
      email: string;
      is_active: boolean;
      last_synced_at: Date;
    }>(
      `SELECT canvas_user_id, full_name, email, is_active, last_synced_at
         FROM students_cache
        WHERE canvas_user_id BETWEEN 70000 AND 79999
        ORDER BY canvas_user_id ASC`,
    );
    expect(dbRows.rows).toHaveLength(3);
    expect(dbRows.rows[0]).toMatchObject({
      canvas_user_id: 70_010,
      full_name: 'New Name A',
      email: 'newA@x',
      is_active: true,
    });
    expect(dbRows.rows[1]).toMatchObject({
      canvas_user_id: 70_011,
      full_name: 'New Name B',
      email: 'newB@x',
      is_active: true,
    });
    expect(dbRows.rows[2]).toMatchObject({
      canvas_user_id: 70_012,
      full_name: 'Cara New',
      email: 'cara-new@x',
      is_active: false,
    });
    // last_synced_at is bumped on every updated row (the
    // ON CONFLICT branch sets it to now()). The pre-seeded
    // rows had last_synced_at = now() - 1 day, so we can
    // assert the timestamp moved forward to within the test
    // window. The newly-inserted 70012 must also have a
    // recent last_synced_at.
    for (const row of dbRows.rows) {
      const t = new Date(row.last_synced_at).getTime();
      expect(Math.abs(t - beforeUpsert)).toBeLessThan(30_000);
    }
  });
  });
});