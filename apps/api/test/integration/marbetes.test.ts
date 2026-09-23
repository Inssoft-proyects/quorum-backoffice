/**
 * WU3b integration tests: full CRUD with mocked OTP service + audit writes.
 *
 * WU8b1 extends:
 *   - the `seedStudent` helper accepts an `active` flag (default true)
 *   - the PATCH test uses `canvasUserId` (the external Canvas id) instead of
 *     the internal `students_cache.id`
 *   - the new `assignment by canvas_user_id` describe block covers the
 *     happy path, the 422 student_not_found rejection (unknown canvas id),
 *     the 422 student_not_active rejection (inactive row), and the
 *     unassign-by-null path.
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
    const canvasId = 99101;
    await seedStudent(canvasId, 'Grace Hopper', 'grace@quorum.local');
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
      payload: JSON.stringify({ canvasUserId: canvasId }),
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

describe('assignment by canvas_user_id (WU8b1)', () => {
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

  function happyHeaders(): Record<string, string> {
    return {
      'x-test-actor': 'tester',
      'x-otp-code': VALID_OTP,
      'content-type': 'application/json',
    };
  }

  it('POST assigns via canvasUserId to an active student → 201', async () => {
    const canvasId = 70_001;
    await seedStudent(canvasId, 'Ada Lovelace', `ada-${canvasId}@quorum.local`);
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes',
      headers: happyHeaders(),
      payload: JSON.stringify({ code: 'ASSIGN-ACTIVE-1', canvasUserId: canvasId }),
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as {
      id: number;
      assignedStudentId: number;
      student: { canvasUserId: number; fullName: string } | null;
    };
    expect(body.assignedStudentId).not.toBeNull();
    expect(body.student?.canvasUserId).toBe(canvasId);
    expect(body.student?.fullName).toBe('Ada Lovelace');
  });

  it('POST with unknown canvasUserId → 422 student_not_found', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes',
      headers: happyHeaders(),
      payload: JSON.stringify({ code: 'ASSIGN-UNKNOWN-1', canvasUserId: 888_888_888 }),
    });
    expect(r.statusCode).toBe(422);
    const body = r.json() as { code: string; details?: { canvasUserId?: number } };
    expect(body.code).toBe('student_not_found');
    expect(body.details?.canvasUserId).toBe(888_888_888);
  });

  it('POST with inactive student (is_active = false) → 422 student_not_active', async () => {
    const canvasId = 70_002;
    await seedStudent(canvasId, 'Inactive Student', `inactive-${canvasId}@quorum.local`, false);
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes',
      headers: happyHeaders(),
      payload: JSON.stringify({ code: 'ASSIGN-INACTIVE-1', canvasUserId: canvasId }),
    });
    expect(r.statusCode).toBe(422);
    const body = r.json() as { code: string; details?: { canvasUserId?: number } };
    expect(body.code).toBe('student_not_active');
    expect(body.details?.canvasUserId).toBe(canvasId);
  });

  it('PATCH assigns via canvasUserId to an active student → 200', async () => {
    const canvasId = 70_003;
    const studentId = await seedStudent(canvasId, 'Linus Torvalds', `linus-${canvasId}@quorum.local`);
    const c = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes',
      headers: happyHeaders(),
      payload: JSON.stringify({ code: 'PATCH-ASSIGN-1' }),
    });
    const cid = (c.json() as { id: number }).id;
    const p = await app.inject({
      method: 'PATCH',
      url: `/api/v1/marbetes/${cid}`,
      headers: happyHeaders(),
      payload: JSON.stringify({ canvasUserId: canvasId }),
    });
    expect(p.statusCode).toBe(200);
    const detail = p.json() as { assignedStudentId: number };
    expect(detail.assignedStudentId).toBe(studentId);
  });

  it('PATCH with unknown canvasUserId → 422 student_not_found', async () => {
    const c = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes',
      headers: happyHeaders(),
      payload: JSON.stringify({ code: 'PATCH-UNKNOWN-1' }),
    });
    const cid = (c.json() as { id: number }).id;
    const p = await app.inject({
      method: 'PATCH',
      url: `/api/v1/marbetes/${cid}`,
      headers: happyHeaders(),
      payload: JSON.stringify({ canvasUserId: 777_777_777 }),
    });
    expect(p.statusCode).toBe(422);
    const body = p.json() as { code: string };
    expect(body.code).toBe('student_not_found');
  });

  it('PATCH with inactive student → 422 student_not_active', async () => {
    const canvasId = 70_004;
    await seedStudent(canvasId, 'Withdrawn', `withdrawn-${canvasId}@quorum.local`, false);
    const c = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes',
      headers: happyHeaders(),
      payload: JSON.stringify({ code: 'PATCH-INACTIVE-1' }),
    });
    const cid = (c.json() as { id: number }).id;
    const p = await app.inject({
      method: 'PATCH',
      url: `/api/v1/marbetes/${cid}`,
      headers: happyHeaders(),
      payload: JSON.stringify({ canvasUserId: canvasId }),
    });
    expect(p.statusCode).toBe(422);
    const body = p.json() as { code: string };
    expect(body.code).toBe('student_not_active');
  });

  it('PATCH with canvasUserId: null unassigns → 200, assignedStudentId becomes null', async () => {
    const canvasId = 70_005;
    await seedStudent(canvasId, 'Unassigning', `unassign-${canvasId}@quorum.local`);
    const c = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes',
      headers: happyHeaders(),
      payload: JSON.stringify({ code: 'PATCH-UNASSIGN-1', canvasUserId: canvasId }),
    });
    const cid = (c.json() as { id: number }).id;
    const p = await app.inject({
      method: 'PATCH',
      url: `/api/v1/marbetes/${cid}`,
      headers: happyHeaders(),
      payload: JSON.stringify({ canvasUserId: null }),
    });
    expect(p.statusCode).toBe(200);
    const detail = p.json() as { assignedStudentId: number | null; assignedAt: string | null };
    expect(detail.assignedStudentId).toBeNull();
    expect(detail.assignedAt).toBeNull();
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

/**
 * WU #1: POST /api/v1/marbetes/:id/reveal returns the unmasked publicUid
 * for an admin and emits an audit_log entry.
 *
 * Implementation notes (deviation from the handbook description):
 *   - The `audit_action` enum does not include a dedicated `marbete.reveal`
 *     label (extending it would require a new migration). The service tags
 *     the audit row with action `marbete.update` (the closest existing
 *     admin-event label) and folds `motivo` + `comentario` into the
 *     existing `after_jsonb` JSONB column. The integration test asserts
 *     against those columns.
 *   - Role gating: `requireRole('admin')`. The 403 test logs in a seeded
 *     `operator` user via the real /auth/login flow (rbac.test.ts pattern)
 *     because the `x-test-actor` shim is hard-wired to admin.
 *   - Soft-deleted → 409 (mirrors the soft-delete conflict in `delete`).
 */
describe('reveal endpoint (WU #1)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: Pool;
  let operatorCookie: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    await pool.query(`
      DROP TABLE IF EXISTS sessions CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
      DROP TABLE IF EXISTS audit_log CASCADE;
      DROP TABLE IF EXISTS dispositivos CASCADE;
      DROP TABLE IF EXISTS marbetes CASCADE;
      DROP TABLE IF EXISTS students_cache CASCADE;
      DROP TYPE IF EXISTS user_role CASCADE;
      DROP TYPE IF EXISTS audit_action CASCADE;
      DROP TYPE IF EXISTS dispositivo_status CASCADE;
      DROP TYPE IF EXISTS marbete_status CASCADE;
      DROP TABLE IF EXISTS _migrations CASCADE;
    `);
    await migrate({ pool, dir: path.resolve(__dirname, '..', '..', 'migrations') });

    // Seed an operator user for the 403 test. Mirrors rbac.test.ts.
    const bcrypt = await import('bcrypt');
    const hash = await bcrypt.hash('Op3r@Pass', 10);
    const opEmail = `reveal-operator-${Date.now()}@example.test`;
    await pool.query(
      `INSERT INTO users (email, password_hash, role) VALUES (lower($1), $2, 'operator')`,
      [opEmail, hash],
    );

    app = await buildApp({ config: TEST_ENV });
    const fetchMock = makeOtpFetch((body) => {
      const code = (body as { code?: string }).code;
      if (code === VALID_OTP) return { status: 200, body: { id: MOCK_OTP_ID } };
      return { status: 401, body: { error: 'invalid' } };
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    // Log the operator in via the real auth flow.
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: opEmail, password: 'Op3r@Pass' }),
    });
    if (loginRes.statusCode !== 200) {
      throw new Error(`operator_login_failed: ${loginRes.statusCode} ${loginRes.body}`);
    }
    const setCookie = loginRes.headers['set-cookie'];
    const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const sidCookie = arr.find((c) => c.startsWith('sid='));
    if (!sidCookie) throw new Error('operator_login_no_cookie');
    operatorCookie = sidCookie.split(';')[0] ?? '';
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  function adminHeaders(): Record<string, string> {
    return {
      'x-test-actor': 'tester',
      'x-otp-code': VALID_OTP,
      'content-type': 'application/json',
    };
  }

  function operatorHeaders(): Record<string, string> {
    return {
      cookie: operatorCookie,
      'x-otp-code': VALID_OTP,
      'content-type': 'application/json',
    };
  }

  async function seedMarbete(code: string): Promise<{ id: number; publicUid: string }> {
    const c = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes',
      headers: adminHeaders(),
      payload: JSON.stringify({ code }),
    });
    expect(c.statusCode).toBe(201);
    return c.json() as { id: number; publicUid: string };
  }

  it('POST /reveal returns the full publicUid for an admin', async () => {
    const seeded = await seedMarbete('REVEAL-HAPPY-1');
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/marbetes/${seeded.id}/reveal`,
      headers: adminHeaders(),
      payload: JSON.stringify({ motivo: 'auditoria' }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { code: string; revealedAt: string };
    expect(body.code).toBe(seeded.publicUid);
    expect(typeof body.revealedAt).toBe('string');
    expect(() => new Date(body.revealedAt).toISOString()).not.toThrow();
  });

  it('POST /reveal emits an audit_log row tagged marbete.update + motivo in after_jsonb', async () => {
    const seeded = await seedMarbete('REVEAL-AUDIT-1');
    const motivo = `motivo-${Date.now()}`;
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/marbetes/${seeded.id}/reveal`,
      headers: adminHeaders(),
      payload: JSON.stringify({ motivo, comentario: 'verificacion de inventario' }),
    });
    expect(r.statusCode).toBe(200);

    // The service tags the audit row with action='marbete.update' (closest
    // existing enum value) and folds motivo + comentario into after_jsonb
    // (no dedicated `metadata` column in the current schema).
    const audit = await pool.query<{
      action: string;
      after_jsonb: { motivo?: string; comentario?: string } | null;
      otp_id: string | null;
    }>(
      `SELECT action::text AS action, after_jsonb::text::jsonb AS after_jsonb, otp_id
         FROM audit_log
        WHERE entity_type = 'marbete' AND entity_id = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [seeded.publicUid],
    );
    const row = audit.rows[0];
    expect(row).toBeDefined();
    expect(row?.action).toBe('marbete.update');
    expect(row?.otp_id).toBe(MOCK_OTP_ID);
    expect(row?.after_jsonb?.motivo).toBe(motivo);
    expect(row?.after_jsonb?.comentario).toBe('verificacion de inventario');
  });

  it('POST /reveal returns 403 for operator role (operator cannot reveal)', async () => {
    const seeded = await seedMarbete('REVEAL-403-1');
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/marbetes/${seeded.id}/reveal`,
      headers: operatorHeaders(),
      payload: JSON.stringify({ motivo: 'auditoria' }),
    });
    expect(r.statusCode).toBe(403);
  });

  it('POST /reveal returns 404 for an unknown id', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/marbetes/999999/reveal',
      headers: adminHeaders(),
      payload: JSON.stringify({ motivo: 'auditoria' }),
    });
    expect(r.statusCode).toBe(404);
  });

  it('POST /reveal returns 409 for a soft-deleted marbete', async () => {
    const seeded = await seedMarbete('REVEAL-CONFLICT-1');
    // Soft-delete via the existing DELETE flow.
    const d = await app.inject({
      method: 'DELETE',
      url: `/api/v1/marbetes/${seeded.id}`,
      headers: adminHeaders(),
      payload: JSON.stringify({ reason: 'lost in transit' }),
    });
    expect(d.statusCode).toBe(200);
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/marbetes/${seeded.id}/reveal`,
      headers: adminHeaders(),
      payload: JSON.stringify({ motivo: 'auditoria' }),
    });
    expect(r.statusCode).toBe(409);
  });
});

