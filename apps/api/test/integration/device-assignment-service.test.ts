/**
 * B2b / Admin device-to-student assignment — integration tests.
 *
 * End-to-end coverage of DispositivosService.assign and
 * DispositivosService.unassign against a real PostgreSQL. The OtpClient
 * is mocked at the global fetch level (same pattern as
 * test/integration/dispositivos.test.ts) so destructive scopes
 * `dispositivo.assign` and `dispositivo.unassign` resolve to a fixed
 * otpId and the audit_log row carries it.
 *
 * Coverage:
 *   - assign happy path: persisted assigned_student_id, audit row with
 *     action='dispositivo.assign', before/after JSONB, otp_id
 *   - reassignment: a different active student replaces the prior owner;
 *     audit before/after diff captures both
 *   - unassign happy path: persisted assigned_student_id=NULL, audit
 *     row with action='dispositivo.unassign'
 *   - assign to an inactive student is rejected with 422
 *     student_not_active; the column stays NULL; no audit row
 *   - unassign on a row that is already unassigned is rejected with
 *     409 device_not_assigned; no audit row
 *   - existing CRUD regression spot-check (create/update/revoke still
 *     behave after the DESTRUCTIVE_ACTIONS extension)
 *
 * The migration runner applies 0016_audit_action_device_assignment.sql
 * so the new enum values exist on the test database.
 */
import { Pool, types } from 'pg';
import path from 'node:path';
import { buildApp } from '../../src/app';
import { migrate } from '../../src/migrations';
import { PgDispositivoRepo } from '../../src/repositories/pg-dispositivos';
import { DispositivosService } from '../../src/services/dispositivos-service';
import type { OtpClient } from '../../src/services/otp-client';
import { AppError } from '../../src/lib/errors';

const TEST_DATABASE_URL =
  process.env['DATABASE_URL_TEST'] ??
  'postgresql://websop:quorum_backoffice_dev@127.0.0.1:5432/quorum_backoffice_test';

// BIGINT (oid 20) is parsed as a number — mirrors the parser app.ts
// installs at module load. dispositivos.id and students_cache.id are
// both BIGINT, and the service returns numeric ids in the response.
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

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
const MOCK_OTP_ID = 'otp-test-fixed-assign';

interface OtpFetchResponse {
  status: number;
  body: unknown;
}

function makeOtpFetch(behaviour: (body: { code?: string; scope?: string }) => OtpFetchResponse): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/otps/verify')) {
      const raw = init?.body ? String(init.body) : '{}';
      const parsed = JSON.parse(raw) as { code?: string; scope?: string };
      const r = behaviour(parsed);
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

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
    assignedStudentId?: number | null;
  },
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO dispositivos
       (serial_number, brand, model, status, created_by, assigned_student_id)
     VALUES ($1, 'TestBrand', 'TestModel', $2::dispositivo_status, 'tester', $3)
     RETURNING id`,
    [args.serial, args.status ?? 'active', args.assignedStudentId ?? null],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('device_seed_failed');
  return id;
}

async function fetchAssignedStudentId(pool: Pool, deviceId: number): Promise<number | null> {
  const r = await pool.query<{ assigned_student_id: number | null }>(
    `SELECT assigned_student_id FROM dispositivos WHERE id = $1`,
    [deviceId],
  );
  return r.rows[0]?.assigned_student_id ?? null;
}

async function auditRow(
  pool: Pool,
  action: 'dispositivo.assign' | 'dispositivo.unassign',
  entityId: string,
): Promise<{
  before: unknown;
  after: unknown;
  otpId: string | null;
} | null> {
  const r = await pool.query<{
    before_jsonb: unknown;
    after_jsonb: unknown;
    otp_id: string | null;
  }>(
    `SELECT before_jsonb, after_jsonb, otp_id
       FROM audit_log
      WHERE action = $1
        AND entity_type = 'dispositivo'
        AND entity_id = $2
      ORDER BY id DESC
      LIMIT 1`,
    [action, entityId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { before: row.before_jsonb, after: row.after_jsonb, otpId: row.otp_id };
}

async function auditCount(
  pool: Pool,
  action: 'dispositivo.assign' | 'dispositivo.unassign',
  entityId: string,
): Promise<number> {
  const r = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM audit_log
      WHERE action = $1
        AND entity_type = 'dispositivo'
        AND entity_id = $2`,
    [action, entityId],
  );
  return Number(r.rows[0]?.count ?? '0');
}

/**
 * Inline fake OtpClient that bypasses HMAC signing and the HTTP layer.
 * Service-level tests build a DispositivosService with this fake; the
 * destructive scopes `dispositivo.assign` and `dispositivo.unassign` are
 * always accepted (we test the DB-level contract here, not the OTP
 * transport).
 */
class FakeOtpClient {
  async verify(args: { subject: string; scope: string; code: string }) {
    if (args.code !== VALID_OTP) return { ok: false as const, reason: 'invalid' as const };
    return { ok: true as const, otpId: MOCK_OTP_ID };
  }
}

const META = { ip: '127.0.0.1', userAgent: 'jest-integration/1.0' };
const ACTOR = 'admin@quorum.local';

describe('DispositivosService.assign/unassign (integration, real PG)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;
  // The service is shared across tests in this suite because it owns
  // only the pool, log, and OtpClient — none of which carry per-test
  // state. Resetting the seed tables in beforeEach keeps the
  // deterministic-shape contract.
  let service: DispositivosService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    // Recreate the schema from scratch so this file is independent of
    // any other test file (and so the audit_action enum starts clean).
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
    (globalThis as { fetch: typeof fetch }).fetch = makeOtpFetch((body) => {
      if (body.code === VALID_OTP) return { status: 200, body: { id: MOCK_OTP_ID } };
      return { status: 401, body: { error: 'invalid' } };
    });

    service = new DispositivosService({
      pool,
      log: app.log,
      otp: new FakeOtpClient() as unknown as OtpClient,
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    // Keep the suite independent: clear audit and seed tables per test.
    await pool.query(`TRUNCATE TABLE audit_log RESTART IDENTITY`);
    await pool.query(`DELETE FROM dispositivos`);
    await pool.query(`DELETE FROM students_cache`);
  });

  // -------------------------------------------------------------------
  // assign
  // -------------------------------------------------------------------

  it('assign: persists assigned_student_id and writes audit with before/after + otp_id', async () => {
    const studentId = await seedStudent(pool, 80_001, 'Marie Curie', true);
    const deviceId = await seedDevice(pool, { serial: 'SN-B2B-ASSIGN-1' });

    const result = await service.assign(
      ACTOR,
      deviceId,
      { canvasUserId: 80_001 },
      VALID_OTP,
      META,
    );

    expect(result.assignedStudentId).toBe(studentId);
    expect(await fetchAssignedStudentId(pool, deviceId)).toBe(studentId);

    const audit = await auditRow(pool, 'dispositivo.assign', String(deviceId));
    expect(audit).not.toBeNull();
    expect(audit?.otpId).toBe(MOCK_OTP_ID);
    const before = audit?.before as { assignedStudentId: number | null } | null;
    const after = audit?.after as { assignedStudentId: number | null } | null;
    expect(before?.assignedStudentId).toBeNull();
    expect(after?.assignedStudentId).toBe(studentId);
    expect(await auditCount(pool, 'dispositivo.assign', String(deviceId))).toBe(1);
  });

  it('assign: reassignment to a different active student replaces assigned_student_id', async () => {
    const firstStudentId = await seedStudent(pool, 80_002, 'First Owner', true);
    const secondStudentId = await seedStudent(pool, 80_003, 'Second Owner', true);
    const deviceId = await seedDevice(pool, {
      serial: 'SN-B2B-ASSIGN-2',
      assignedStudentId: firstStudentId,
    });

    const result = await service.assign(
      ACTOR,
      deviceId,
      { canvasUserId: 80_003 },
      VALID_OTP,
      META,
    );

    expect(result.assignedStudentId).toBe(secondStudentId);
    expect(await fetchAssignedStudentId(pool, deviceId)).toBe(secondStudentId);

    const audit = await auditRow(pool, 'dispositivo.assign', String(deviceId));
    const before = audit?.before as { assignedStudentId: number | null } | null;
    const after = audit?.after as { assignedStudentId: number | null } | null;
    expect(before?.assignedStudentId).toBe(firstStudentId);
    expect(after?.assignedStudentId).toBe(secondStudentId);
  });

  it('assign: rejected for an inactive student (column stays NULL; no audit row)', async () => {
    await seedStudent(pool, 80_004, 'Withdrawn Student', false);
    const deviceId = await seedDevice(pool, { serial: 'SN-B2B-ASSIGN-3' });

    const err: AppError = await service
      .assign(ACTOR, deviceId, { canvasUserId: 80_004 }, VALID_OTP, META)
      .then(
        () => {
          throw new Error('expected throw');
        },
        (e: unknown) => e as AppError,
      );
    expect(err.code).toBe('student_not_active');
    expect(err.httpStatus).toBe(422);

    expect(await fetchAssignedStudentId(pool, deviceId)).toBeNull();
    expect(await auditCount(pool, 'dispositivo.assign', String(deviceId))).toBe(0);
  });

  // -------------------------------------------------------------------
  // unassign
  // -------------------------------------------------------------------

  it('unassign: clears assigned_student_id and writes audit with before/after + otp_id', async () => {
    const studentId = await seedStudent(pool, 80_010, 'Owner To Unbind', true);
    const deviceId = await seedDevice(pool, {
      serial: 'SN-B2B-UNASSIGN-1',
      assignedStudentId: studentId,
    });

    const result = await service.unassign(ACTOR, deviceId, VALID_OTP, META);

    expect(result.assignedStudentId).toBeNull();
    expect(await fetchAssignedStudentId(pool, deviceId)).toBeNull();

    const audit = await auditRow(pool, 'dispositivo.unassign', String(deviceId));
    expect(audit).not.toBeNull();
    expect(audit?.otpId).toBe(MOCK_OTP_ID);
    const before = audit?.before as { assignedStudentId: number | null } | null;
    const after = audit?.after as { assignedStudentId: number | null } | null;
    expect(before?.assignedStudentId).toBe(studentId);
    expect(after?.assignedStudentId).toBeNull();
    expect(await auditCount(pool, 'dispositivo.unassign', String(deviceId))).toBe(1);
  });

  it('unassign: rejected with 409 when the device is already unassigned (no audit row)', async () => {
    const deviceId = await seedDevice(pool, {
      serial: 'SN-B2B-UNASSIGN-2',
      assignedStudentId: null,
    });

    const err: AppError = await service
      .unassign(ACTOR, deviceId, VALID_OTP, META)
      .then(
        () => {
          throw new Error('expected throw');
        },
        (e: unknown) => e as AppError,
      );
    expect(err.code).toBe('device_not_assigned');
    expect(err.httpStatus).toBe(409);

    expect(await fetchAssignedStudentId(pool, deviceId)).toBeNull();
    expect(await auditCount(pool, 'dispositivo.unassign', String(deviceId))).toBe(0);
  });

  // -------------------------------------------------------------------
  // existing CRUD regression — the DESTRUCTIVE_ACTIONS extension must
  // not break the previously-shipped flows.
  // -------------------------------------------------------------------

  it('existing CRUD still works: create, update, revoke (regression spot-check)', async () => {
    // CREATE
    const create = await service.create(
      ACTOR,
      { serialNumber: 'SN-B2B-CRUD-CREATE', brand: 'Apple', model: 'iPad' },
      VALID_OTP,
      META,
    );
    expect(create.status).toBe('active');
    expect(create.serialNumber).toBe('SN-B2B-CRUD-CREATE');

    // UPDATE
    const updated = await service.update(
      ACTOR,
      create.id,
      { model: 'iPad Air' },
      VALID_OTP,
      META,
    );
    expect(updated.model).toBe('iPad Air');

    // REVOKE
    const revoked = await service.revoke(
      ACTOR,
      create.id,
      { reason: 'end-of-life' },
      VALID_OTP,
      META,
    );
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedReason).toBe('end-of-life');

    // DETAIL
    const detail = await service.detail(create.id);
    expect(detail.id).toBe(create.id);
  });
});
