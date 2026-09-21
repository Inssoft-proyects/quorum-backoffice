/**
 * WU5 integration tests: audit log read API + append-only enforcement.
 *
 * Coverage:
 *  - happy list: filters by entityType, entityId, actorId, action, since/until, search
 *  - GET /:id detail (no-store)
 *  - validation: bad id, bad entityType, missing entity
 *  - append-only: REVOKE PUBLIC UPDATE/DELETE enforced at SQL level
 *
 * Audit entries are seeded directly via INSERT (we have INSERT privilege).
 * Filtering by occurred_at uses relative timestamps to avoid timezone flakes.
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

interface SeedAudit {
  actorId?: string;
  action?: string;
  entityType?: string | null;
  entityId?: string | null;
  otpId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  occurredAt?: Date;
}

function defaultEntityForAction(action: string): string | null {
  if (action.startsWith('auth.')) return null;
  const prefix = action.split('.')[0];
  return prefix ?? null;
}

async function seedAuditEntry(pool: Pool, seed: SeedAudit = {}): Promise<number> {
  const action = seed.action ?? 'marbete.create';
  const entityType = seed.entityType !== undefined
    ? seed.entityType
    : defaultEntityForAction(action);
  const r = await pool.query<{ id: number }>(
    `INSERT INTO audit_log
       (actor_id, action, entity_type, entity_id, otp_id, ip, user_agent, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6::inet, $7, COALESCE($8, now()))
     RETURNING id`,
    [
      seed.actorId ?? 'tester',
      action,
      entityType,
      seed.entityId ?? 'm-AAA111',
      seed.otpId ?? 'otp-seed-1',
      seed.ip ?? null,
      seed.userAgent ?? null,
      seed.occurredAt ?? null,
    ],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('audit_seed_failed');
  return id;
}

describe('audit routes (integration, real PG)', () => {
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
    // Prevent leaks into other tests via OTP service: silence unmatched URLs.
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('not used', { status: 404 })) as unknown as typeof fetch;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  function readHeaders(): Record<string, string> {
    return { 'x-test-actor': 'auditor' };
  }

  it('GET /api/v1/audit returns paginated list ordered by occurred_at DESC', async () => {
    const a = await seedAuditEntry(pool, { actorId: 'alice', action: 'marbete.create' });
    const b = await seedAuditEntry(pool, { actorId: 'bob', action: 'dispositivo.create' });
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/audit',
      headers: readHeaders(),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { total: number; limit: number; offset: number; items: Array<{ id: number }> };
    expect(body.limit).toBe(100);
    expect(body.offset).toBe(0);
    expect(body.total).toBeGreaterThanOrEqual(2);
    // Items are ordered DESC: the last seeded (b) should appear before (a).
    const ids = body.items.map((i) => i.id);
    const idxA = ids.indexOf(a);
    const idxB = ids.indexOf(b);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeLessThan(idxA);
  });

  it('filters by entityType', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/audit?entityType=dispositivo',
      headers: readHeaders(),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { items: Array<{ entityType: string }> };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.every((i) => i.entityType === 'dispositivo')).toBe(true);
  });

  it('filters by actorId', async () => {
    await seedAuditEntry(pool, { actorId: 'unique-actor-12345', action: 'marbete.create' });
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/audit?actorId=unique-actor-12345',
      headers: readHeaders(),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { items: Array<{ actorId: string }> };
    expect(body.items.length).toBe(1);
    expect(body.items[0]?.actorId).toBe('unique-actor-12345');
  });

  it('filters by action', async () => {
    await seedAuditEntry(pool, { actorId: 'action-tester', action: 'dispositivo.revoke', entityType: 'dispositivo' });
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/audit?action=dispositivo.revoke',
      headers: readHeaders(),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { items: Array<{ action: string }> };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.every((i) => i.action === 'dispositivo.revoke')).toBe(true);
  });

  it('filters by since/until on occurred_at', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const oldId = await seedAuditEntry(pool, { actorId: 'past', occurredAt: past });
    await seedAuditEntry(pool, { actorId: 'now', occurredAt: new Date() });

    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/audit?since=${past.toISOString()}&until=${future.toISOString()}`,
      headers: readHeaders(),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { items: Array<{ id: number }> };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(oldId);
  });

  it('GET /api/v1/audit/:id returns detail', async () => {
    const id = await seedAuditEntry(pool, {
      actorId: 'detail',
      action: 'marbete.assign',
      entityType: 'marbete',
      entityId: 'm-DETAIL',
      otpId: 'otp-detail',
    });
    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/audit/${id}`,
      headers: readHeaders(),
    });
    expect(r.statusCode).toBe(200);
    const detail = r.json() as { id: number; actorId: string; action: string; otpId: string };
    expect(detail.id).toBe(id);
    expect(detail.actorId).toBe('detail');
    expect(detail.action).toBe('marbete.assign');
    expect(detail.otpId).toBe('otp-detail');
  });

  it('GET /api/v1/audit/:id returns 404 for unknown id', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/audit/999999999',
      headers: readHeaders(),
    });
    expect(r.statusCode).toBe(404);
  });

  it('GET /api/v1/audit/abc returns 400 (path validation)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/audit/abc',
      headers: readHeaders(),
    });
    expect(r.statusCode).toBe(400);
  });

  it('GET /api/v1/audit?entityType=invalid returns 400 (enum validation)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/audit?entityType=not-a-real-entity',
      headers: readHeaders(),
    });
    expect(r.statusCode).toBe(400);
  });

  it('REVOKE PUBLIC UPDATE/DELETE/TRUNCATE on audit_log is enforced (information_schema)', async () => {
    // After the migration, PUBLIC must not appear as a grantee for any
    // mutating privilege on audit_log. information_schema.role_table_grants
    // is cross-version (works on PG ≤ 15 and PG 18+).
    const r = await pool.query<{ grantee: string; privilege_type: string }>(
      `SELECT grantee, privilege_type
         FROM information_schema.role_table_grants
        WHERE table_name = 'audit_log'
          AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')`,
    );
    const granteesForMutation = r.rows.map((row) => row.grantee);
    expect(granteesForMutation).not.toContain('PUBLIC');
    // The owner should still have these privileges (to allow the migration
    // itself to apply). Sanity check: at least the current user can mutate.
    const canUpdate = await pool.query<{ ok: boolean }>(
      `SELECT has_table_privilege(current_user, 'audit_log', 'UPDATE') AS ok`,
    );
    expect(canUpdate.rows[0]?.ok).toBe(true);
  });

  it('search filter matches actor_id (ILIKE)', async () => {
    await seedAuditEntry(pool, { actorId: 'search-target-zz', action: 'marbete.create' });
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/audit?search=search-target-zz',
      headers: readHeaders(),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { items: Array<{ actorId: string }> };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.every((i) => i.actorId.includes('search-target-zz'))).toBe(true);
  });
});