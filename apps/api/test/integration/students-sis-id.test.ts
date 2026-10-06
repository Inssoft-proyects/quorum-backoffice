/**
 * Synthetic high-privacy students (sis_id + canvas_user_id only) —
 * end-to-end integration coverage (real PG).
 *
 * Migration 0020_students_sis_id.sql adds a nullable `sis_id TEXT` column
 * to `students_cache` with a UNIQUE partial index, and drops the
 * `NOT NULL` constraints on `full_name` and `email`. The new contract:
 *
 *   - A row can be inserted with ONLY `canvas_user_id` + `sis_id`
 *     (the new UNIQUE matrícula), with NULL `full_name` / `email`.
 *     This is the synthetic test-data shape used to populate the
 *     cache without leaking personal data.
 *   - `sis_id` is unique (case-insensitive upper matrícula, 6 chars).
 *   - The DTO returned by `GET /api/v1/students` exposes `sisId` and
 *     keeps `fullName` / `email` as nullable strings on the wire.
 *
 * Coverage:
 *   (a) End-to-end: insert a synthetic row with no PII, GET it, and
 *       verify the DTO has `sisId: <matrícula>`, `fullName: null`,
 *       `email: null`, `isActive: true`. This exercises the
 *       repo → service → route → JSON serializer path against a
 *       real PG row.
 *   (b) Uniqueness: a second INSERT with the same `sis_id` is
 *       rejected by the partial UNIQUE index (`uq_students_sis_id`).
 *   (c) Backward compat: a legacy row (full_name + email present,
 *       no sis_id) still maps to a DTO with non-null name/email
 *       and `sisId: null` — no wire breakage.
 *   (d) Migration idempotency: re-running the migration runner
 *       against an already-applied state applies zero files.
 */
import { Pool } from 'pg';
import path from 'node:path';
import { buildApp } from '../../src/app';
import { migrate, ensureMigrationsTable } from '../../src/migrations';

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

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

interface StudentDetailBody {
  id: number;
  canvasUserId: number;
  sisId: string | null;
  fullName: string | null;
  email: string | null;
  isActive: boolean;
}

describe('synthetic high-privacy students — sis_id + canvas_user_id only (integration, real PG)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    // Each run starts from a clean slate so the test is order-independent
    // and can be re-run without a manual DB reset. Mirrors the cleanup
    // block in test/integration/students.test.ts.
    await ensureMigrationsTable(pool);
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
    // Apply every migration including 0020_students_sis_id.sql. The
    // migration is required to be present in the dir for this test
    // to be meaningful; if it's missing the test below fails on
    // information_schema lookups, surfacing the regression early.
    const result = await migrate({ pool, dir: MIGRATIONS_DIR });
    const expectedNew = '0020_students_sis_id.sql';
    if (!result.applied.includes(expectedNew)) {
      throw new Error(
        `expected ${expectedNew} to be in the applied list, got: ${result.applied.join(', ')}`,
      );
    }
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

  it('migration 0020 adds a nullable sis_id TEXT column to students_cache with a UNIQUE partial index', async () => {
    // Verify the column shape (nullable, text, no default that
    // would mask the NULL case for synthetic rows).
    const col = await pool.query<{
      column_name: string;
      is_nullable: string;
      data_type: string;
    }>(
      `SELECT column_name, is_nullable, data_type
         FROM information_schema.columns
        WHERE table_name = 'students_cache' AND column_name = 'sis_id'`,
    );
    expect(col.rows).toHaveLength(1);
    expect(col.rows[0]?.is_nullable).toBe('YES');
    expect(col.rows[0]?.data_type).toBe('text');

    // Verify the unique index exists. The migration is the only
    // author of `uq_students_sis_id` so a missing index surfaces a
    // regression in the unique-constraint story.
    const idx = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'uq_students_sis_id'`,
    );
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0]?.indexdef.toLowerCase()).toMatch(/unique/);
    // The partial predicate keeps the constraint scoped to non-NULL
    // sis_id values so legacy rows (sis_id IS NULL) coexist freely.
    expect(idx.rows[0]?.indexdef).toMatch(/WHERE/);
  });

  it('migration 0020 drops NOT NULL on full_name and email', async () => {
    const cols = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'students_cache' AND column_name IN ('full_name', 'email')`,
    );
    const byName = new Map(cols.rows.map((r) => [r.column_name, r.is_nullable]));
    expect(byName.get('full_name')).toBe('YES');
    expect(byName.get('email')).toBe('YES');
  });

  it('(a) inserts a synthetic row with only canvas_user_id + sis_id (no PII) and GETs it back with nulls and sisId on the DTO', async () => {
    // The synthetic test-data shape: no full_name, no email, just
    // the matrícula that the operator used to seed the cache.
    // This row is invisible from a PII standpoint but is fully
    // addressable via the canvas_user_id (the existing wire key).
    const canvasId = 90_001 + Math.floor(Math.random() * 9_000);
    const sisId = 'ABC123';
    await pool.query(
      `INSERT INTO students_cache (canvas_user_id, sis_id, is_active)
       VALUES ($1, $2, TRUE)`,
      [canvasId, sisId],
    );

    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/students?canvasUserId=${canvasId}`,
      headers: readHeaders(),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as StudentDetailBody;
    expect(body.canvasUserId).toBe(canvasId);
    expect(body.sisId).toBe(sisId);
    expect(body.fullName).toBeNull();
    expect(body.email).toBeNull();
    expect(body.isActive).toBe(true);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('(c) a legacy row (full_name + email, no sis_id) still maps to a DTO with non-null name/email and sisId=null', async () => {
    // Backward compat: an existing fully-populated row continues
    // to work end-to-end. The change must not break the wire shape
    // for the operator's normal flow.
    const canvasId = 90_002 + Math.floor(Math.random() * 9_000);
    await pool.query(
      `INSERT INTO students_cache (canvas_user_id, full_name, email, is_active)
       VALUES ($1, $2, $3, TRUE)`,
      [canvasId, 'Ada Lovelace', `ada-${canvasId}@quorum.local`],
    );

    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/students?canvasUserId=${canvasId}`,
      headers: readHeaders(),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as StudentDetailBody;
    expect(body.canvasUserId).toBe(canvasId);
    expect(body.fullName).toBe('Ada Lovelace');
    expect(body.email).toBe(`ada-${canvasId}@quorum.local`);
    expect(body.sisId).toBeNull();
  });

  it('(b) a second INSERT with the same sis_id is rejected by the UNIQUE partial index', async () => {
    const sisId = `UNIQ${Math.floor(Math.random() * 1000)}`; // 6-ish chars; uniqueness is per-sis_id only
    const canvasA = 91_001 + Math.floor(Math.random() * 9_000);
    const canvasB = 92_001 + Math.floor(Math.random() * 9_000);
    await pool.query(
      `INSERT INTO students_cache (canvas_user_id, sis_id) VALUES ($1, $2)`,
      [canvasA, sisId],
    );
    // A second row with a DIFFERENT canvas_user_id but the SAME
    // sis_id must be rejected. This is the duplicate-matrícula
    // safety net that the B1 SIS lookup eventually depends on.
    await expect(
      pool.query(
        `INSERT INTO students_cache (canvas_user_id, sis_id) VALUES ($1, $2)`,
        [canvasB, sisId],
      ),
    ).rejects.toThrow(/uq_students_sis_id/);
  });

  it('multiple NULL sis_id rows are allowed (the UNIQUE index is partial WHERE sis_id IS NOT NULL)', async () => {
    // PostgreSQL treats each NULL as distinct under a plain
    // UNIQUE constraint, but we go further and make the index
    // partial so a legacy mass-insert that leaves sis_id NULL
    // for thousands of rows does not bloat the unique index.
    // This test pins the partial-predicate design: two rows with
    // sis_id IS NULL are both allowed.
    const a = 93_001 + Math.floor(Math.random() * 9_000);
    const b = 94_001 + Math.floor(Math.random() * 9_000);
    await pool.query(
      `INSERT INTO students_cache (canvas_user_id, full_name, email) VALUES ($1, 'X', 'x@x')`,
      [a],
    );
    await pool.query(
      `INSERT INTO students_cache (canvas_user_id, full_name, email) VALUES ($1, 'Y', 'y@y')`,
      [b],
    );
    const c = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM students_cache WHERE sis_id IS NULL AND canvas_user_id IN ($1, $2)`,
      [a, b],
    );
    expect(Number(c.rows[0]?.count)).toBe(2);
  });

  it('(d) re-running the migration runner is a no-op (idempotent)', async () => {
    // The migration uses ADD COLUMN IF NOT EXISTS + CREATE UNIQUE
    // INDEX IF NOT EXISTS + ALTER COLUMN ... DROP NOT NULL (which
    // is itself idempotent). A second apply must apply zero files.
    const result = await migrate({ pool, dir: MIGRATIONS_DIR });
    const justApplied = result.applied.filter((f) => f === '0020_students_sis_id.sql');
    expect(justApplied).toEqual([]);
  });
});
