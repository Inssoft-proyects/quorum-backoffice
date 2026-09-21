/**
 * WU2 integration tests:
 *   1. Runner is idempotent (re-runs apply zero migrations)
 *   2. All four tables exist with expected columns
 *   3. audit_log is append-only: UPDATE/DELETE from a non-owner role fails
 *   4. marbetes one-active-per-student constraint holds
 *
 * Uses quorum_backoffice_test (auto-created by scripts/dev-bootstrap.sh).
 * Test cleanup drops the tables + _migrations between runs so this is safe.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { migrate, ensureMigrationsTable } from '../../src/migrations';

const TEST_DATABASE_URL =
  process.env['DATABASE_URL_TEST'] ??
  'postgresql://websop:quorum_backoffice_dev@127.0.0.1:5432/quorum_backoffice_test';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

describe('migrations runner (integration, real PG)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    await ensureMigrationsTable(pool);
    // Clean before each test run so re-runs are deterministic.
    await pool.query(`
      DROP TABLE IF EXISTS audit_log CASCADE;
      DROP TABLE IF EXISTS dispositivos CASCADE;
      DROP TABLE IF EXISTS marbetes CASCADE;
      DROP TABLE IF EXISTS students_cache CASCADE;
      DROP TYPE IF EXISTS audit_action CASCADE;
      DROP TYPE IF EXISTS dispositivo_status CASCADE;
      DROP TYPE IF EXISTS marbete_status CASCADE;
      DELETE FROM _migrations;
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('applies all 4 migrations', async () => {
    const result = await migrate({ pool, dir: MIGRATIONS_DIR });
    expect(result.applied.sort()).toEqual([
      '0001_init.sql',
      '0002_marbetes.sql',
      '0003_dispositivos.sql',
      '0004_audit.sql',
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('is idempotent on second run', async () => {
    const result = await migrate({ pool, dir: MIGRATIONS_DIR });
    expect(result.applied).toEqual([]);
    expect(result.skipped.sort()).toEqual([
      '0001_init.sql',
      '0002_marbetes.sql',
      '0003_dispositivos.sql',
      '0004_audit.sql',
    ]);
  });

  it('creates all four expected tables', async () => {
    const r = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('students_cache','marbetes','dispositivos','audit_log') ORDER BY tablename",
    );
    expect(r.rows.map((row) => row.tablename)).toEqual([
      'audit_log',
      'dispositivos',
      'marbetes',
      'students_cache',
    ]);
  });

  it('audit_log UPDATE/DELETE revoked from PUBLIC in ACL', async () => {
    // Verify via pg_class.relacl: a PUBLIC entry would show as "=arw...".
    // After REVOKE PUBLIC, only the owner should appear.
    const r = await pool.query<{ relacl: unknown }>(
      "SELECT relacl FROM pg_class WHERE relname='audit_log' AND relnamespace='public'::regnamespace",
    );
    expect(r.rows).toHaveLength(1);
    const acl = r.rows[0]?.relacl ?? [];
    const aclText = JSON.stringify(acl);
    expect(aclText).not.toMatch(/[{,]=/);
    expect(aclText).not.toMatch(/"=/);
  });

  it('audit_log rejects UPDATE and DELETE from a non-owner role', async () => {
    const roleName = 'qb_audit_reader_' + Math.random().toString(36).slice(2, 8);
    await pool.query(`CREATE ROLE ${roleName} NOSUPERUSER NOLOGIN`);
    await pool.query(`GRANT INSERT, SELECT ON audit_log TO ${roleName}`);
    try {
      const acl = await pool.query<{ has_update: boolean; has_delete: boolean }>(
        `SELECT has_table_privilege('${roleName}', 'audit_log', 'UPDATE') AS has_update,
                has_table_privilege('${roleName}', 'audit_log', 'DELETE') AS has_delete`,
      );
      const row = acl.rows[0];
      expect(row?.has_update).toBe(false);
      expect(row?.has_delete).toBe(false);
    } finally {
      await pool.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${roleName}`);
      await pool.query(`DROP ROLE IF EXISTS ${roleName}`);
    }
  });

  it('audit_log accepts INSERT (writes a row)', async () => {
    await pool.query(
      `INSERT INTO audit_log (actor_id, actor_email, action, entity_type, entity_id)
       VALUES ('test-user', 'test@quorum.local', 'marbete.create', 'marbete', 'm-TEST01')`,
    );
    const r = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM audit_log');
    expect(Number(r.rows[0]?.count)).toBeGreaterThanOrEqual(1);
  });

  it('marbetes enforces one-active-per-student', async () => {
    const s = await pool.query<{ id: string }>(
      `INSERT INTO students_cache (canvas_user_id, full_name, email) VALUES (99991, 'Test Student', 's@tests.local') RETURNING id`,
    );
    const studentId = s.rows[0]?.id;
    expect(studentId).toBeDefined();

    await pool.query(
      `INSERT INTO marbetes (public_uid, code_hash, assigned_student_id, created_by)
       VALUES ('m-TEST-A', $1, $2, 'tester')`,
      ['a'.repeat(64), studentId],
    );

    await expect(
      pool.query(
        `INSERT INTO marbetes (public_uid, code_hash, assigned_student_id, created_by)
         VALUES ('m-TEST-B', $1, $2, 'tester')`,
        ['b'.repeat(64), studentId],
      ),
    ).rejects.toThrow(/uq_marbete_active_per_student/);
  });

  it('rejects malformed code_hash', async () => {
    await expect(
      pool.query(
        `INSERT INTO marbetes (public_uid, code_hash, created_by) VALUES ('m-BAD', 'not-a-sha', 'tester')`,
      ),
    ).rejects.toThrow();
  });
});

describe('migrations runner — empty directory (unit)', () => {
  it('returns empty result for empty dir', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qb-mig-'));
    try {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
      try {
        await ensureMigrationsTable(pool);
        const r = await migrate({ pool, dir: tmpDir });
        expect(r).toEqual({ applied: [], skipped: [] });
      } finally {
        await pool.end();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
