/**
 * B1 / Shared-device authorization — fail-closed resolution lookup.
 *
 * Exercises `PgDispositivoRepo.findActiveOwnerBySerialAndCanvasId`
 * against a real PostgreSQL connection. The device is an authorization
 * factor (an approved-device allowlist), NOT an identity factor: it is
 * resolved by `canvas_user_id` (parameter $2). Fase 2 retired the
 * `dispositivos.assigned_student_id` FK column outright (migration
 * 0022); this repository method was always canvas_user_id-driven and
 * is INTENTIONALLY preserved.
 *
 * Each test seeds its own devices and students so the suite is order-
 * independent. The fail-closed contract requires a single negative
 * answer for every non-approvable case; we triangulate:
 *
 *   - happy path     : active device + active student + matching canvas_user_id → resolved
 *   - revoked        : device exists with status='revoked'  → not resolved
 *   - other user     : active device, queried with an active canvas_user_id → resolved
 *   - inactive       : queried canvas_user_id has is_active=false → not resolved
 *   - missing        : canvas_user_id not present in students_cache → not resolved
 *   - missing device : serial that was never registered → not resolved
 *
 * The repository method is the only public surface introduced in B1.
 * No route, no service, no access decision is wired here — that is
 * explicitly deferred to B3 after the service-to-service contract is
 * validated. The tests therefore call the repository directly and
 * never make HTTP requests, so the existing dispositivos route
 * contract is not exercised or modified by this file.
 */
import { Pool, types } from 'pg';
import path from 'node:path';
import { migrate } from '../../src/migrations';
import { PgDispositivoRepo } from '../../src/repositories/pg-dispositivos';
import type { DeviceOwnerCheck } from '../../src/repositories/pg-dispositivos';

const TEST_DATABASE_URL =
  process.env['DATABASE_URL_TEST'] ??
  'postgresql://websop:quorum_backoffice_dev@127.0.0.1:5432/quorum_backoffice_test';

// BIGINT (oid 20) is parsed as a number — mirrors the parser that
// app.ts installs at module load. The dispositivos id and the
// students_cache id are both BIGINT; without this override the raw
// pool returns them as strings, which would not match the
// DeviceOwnerCheck.studentId type or the DTO contract.
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

async function seedStudent(
  pool: Pool,
  canvasId: number,
  name: string,
  active: boolean,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO students_cache (canvas_user_id, full_name, email, is_active)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [canvasId, name, `student-${canvasId}@quorum.local`, active],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('student_seed_failed');
  return id;
}

async function seedDevice(
  pool: Pool,
  args: {
    serial: string;
    status?: 'active' | 'revoked';
    // Fase 2 retired `dispositivos.assigned_student_id`; the seed
    // helper keeps the optional parameter for backward-compatible
    // call sites but ignores it. The shared-device allowlist model
    // binds the device to nothing — the read-path resolves the
    // device by `canvas_user_id` via
    // `findActiveOwnerBySerialAndCanvasId`, NOT by any (now-absent)
    // device→student FK.
  },
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO dispositivos
       (serial_number, brand, model, status, created_by, revoked_at)
     VALUES ($1, 'TestBrand', 'TestModel', $2::dispositivo_status, 'tester', NULL)
     RETURNING id`,
    [args.serial, args.status ?? 'active'],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('device_seed_failed');
  // If the test asked for a revoked device, flip status/revoked_at now
  // so the seed call site stays a single statement.
  if (args.status === 'revoked') {
    await pool.query(
      `UPDATE dispositivos
          SET status = 'revoked', revoked_at = now(), revoked_reason = 'test'
        WHERE id = $1`,
      [id],
    );
  }
  return id;
}

describe('PgDispositivoRepo.findActiveOwnerBySerialAndCanvasId (integration, real PG)', () => {
  let pool: Pool;
  let repo: PgDispositivoRepo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    // Recreate the schema from scratch so the suite is independent of any
    // other test file. The test runner (migrations.test.ts) does the same.
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
    repo = new PgDispositivoRepo(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('returns owner=true for active device with matching canvas_user_id (fase 2 ignores the retired device→student FK)', async () => {
    const studentId = await seedStudent(pool, 50_001, 'Marie Curie', true);
    await seedDevice(pool, {
      serial: 'SN-B1-HAPPY-1',
      status: 'active',
    });

    const result: DeviceOwnerCheck = await repo.findActiveOwnerBySerialAndCanvasId(
      'SN-B1-HAPPY-1',
      50_001,
    );
    expect(result).toEqual({ owner: true, studentId });
  });

  it('returns owner=true for an UNASSIGNED device + active student (shared device allowlist)', async () => {
    const studentId = await seedStudent(pool, 50_002, 'Shared Device User', true);
    await seedDevice(pool, {
      serial: 'SN-B1-UNASSIGNED-1',
      status: 'active',
    });

    const result = await repo.findActiveOwnerBySerialAndCanvasId(
      'SN-B1-UNASSIGNED-1',
      50_002,
    );
    expect(result).toEqual({ owner: true, studentId });
  });

  it('returns owner=false when the device is revoked (fail-closed)', async () => {
    await seedStudent(pool, 50_003, 'Revoked Owner', true);
    await seedDevice(pool, {
      serial: 'SN-B1-REVOKED-1',
      status: 'revoked',
    });

    const result = await repo.findActiveOwnerBySerialAndCanvasId(
      'SN-B1-REVOKED-1',
      50_003,
    );
    expect(result).toEqual({ owner: false, studentId: null });
  });

  it('returns owner=true when the device was previously owned by a DIFFERENT student (binding not enforced)', async () => {
    await seedStudent(pool, 50_004, 'Real Owner', true);
    const impostorId = await seedStudent(pool, 50_005, 'Impostor', true);
    await seedDevice(pool, {
      serial: 'SN-B1-OTHER-USER-1',
      status: 'active',
    });

    const result = await repo.findActiveOwnerBySerialAndCanvasId(
      'SN-B1-OTHER-USER-1',
      50_005,
    );
    expect(result).toEqual({ owner: true, studentId: impostorId });
  });

  it('returns owner=false when the canvas_user_id is inactive (graduated/withdrawn)', async () => {
    await seedStudent(pool, 50_006, 'Withdrawn Student', false);
    await seedDevice(pool, {
      serial: 'SN-B1-INACTIVE-STUDENT-1',
      status: 'active',
    });

    const result = await repo.findActiveOwnerBySerialAndCanvasId(
      'SN-B1-INACTIVE-STUDENT-1',
      50_006,
    );
    expect(result).toEqual({ owner: false, studentId: null });
  });

  it('returns owner=false when the canvas_user_id does not exist in students_cache', async () => {
    await seedStudent(pool, 50_007, 'Real Owner', true);
    await seedDevice(pool, {
      serial: 'SN-B1-MISSING-USER-1',
      status: 'active',
    });

    const result = await repo.findActiveOwnerBySerialAndCanvasId(
      'SN-B1-MISSING-USER-1',
      999_999_999,
    );
    expect(result).toEqual({ owner: false, studentId: null });
  });

  it('returns owner=false for a serial that was never registered', async () => {
    const result = await repo.findActiveOwnerBySerialAndCanvasId(
      'SN-B1-NEVER-EXISTED',
      50_008,
    );
    expect(result).toEqual({ owner: false, studentId: null });
  });

  it('returns the same studentId on a second call (idempotent / read-only)', async () => {
    const studentId = await seedStudent(pool, 50_009, 'Repeatable', true);
    await seedDevice(pool, {
      serial: 'SN-B1-IDEMPOTENT-1',
      status: 'active',
    });
    const a = await repo.findActiveOwnerBySerialAndCanvasId('SN-B1-IDEMPOTENT-1', 50_009);
    const b = await repo.findActiveOwnerBySerialAndCanvasId('SN-B1-IDEMPOTENT-1', 50_009);
    expect(a).toEqual(b);
    expect(a.owner).toBe(true);
    expect(a.studentId).toBe(studentId);
  });
});
