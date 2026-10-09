/**
 * B1 / Canvas-bound device authorization — repository SQL contract.
 *
 * Unit-level test for the fail-closed owner check. We mock the pg
 * client (Pool/PoolClient shape) and assert the SQL + parameter
 * contract, plus the boolean/owner mapping. This test is fully
 * deterministic and does not require a running PostgreSQL: the
 * matching integration suite in test/integration/ exercises the
 * real SQL against a real database.
 *
 * Coverage:
 *   - happy path (one row returned)         → owner=true, studentId=number
 *   - no row returned                       → owner=false, studentId=null
 *   - row.student_id is a string (BIGINT)   → coerced to number (no leak)
 *   - serial + canvas_user_id passed as parameters
 *   - WHERE clause includes every fail-closed predicate
 */
import type pg from 'pg';
import { PgDispositivoRepo } from '../../src/repositories/pg-dispositivos';

interface QueryCall {
  sql: string;
  params: unknown[];
}

interface MockClientOptions {
  rows: Record<string, unknown>[];
}

function makeMockClient(opts: MockClientOptions): {
  client: pg.Pool;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const client = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return { rows: opts.rows };
    }),
  } as unknown as pg.Pool;
  return { client, calls };
}

describe('PgDispositivoRepo.findActiveOwnerBySerialAndCanvasId (unit, mocked pg)', () => {
  it('returns owner=true and the numeric studentId when the row matches', async () => {
    const { client, calls } = makeMockClient({ rows: [{ student_id: 42 }] });
    const repo = new PgDispositivoRepo(client);
    const result = await repo.findActiveOwnerBySerialAndCanvasId('SN-UNIT-1', 1001);
    expect(result).toEqual({ owner: true, studentId: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual(['SN-UNIT-1', 1001]);
  });

  it('coerces a string student_id (raw BIGINT) to a number', async () => {
    const { client } = makeMockClient({ rows: [{ student_id: '777' }] });
    const repo = new PgDispositivoRepo(client);
    const result = await repo.findActiveOwnerBySerialAndCanvasId('SN-UNIT-2', 2002);
    expect(result).toEqual({ owner: true, studentId: 777 });
    expect(typeof result.studentId).toBe('number');
  });

  it('returns owner=false / studentId=null when no row matches', async () => {
    const { client } = makeMockClient({ rows: [] });
    const repo = new PgDispositivoRepo(client);
    const result = await repo.findActiveOwnerBySerialAndCanvasId('SN-UNIT-3', 3003);
    expect(result).toEqual({ owner: false, studentId: null });
  });

  it('issues exactly one query per call (no N+1)', async () => {
    const { client, calls } = makeMockClient({ rows: [] });
    const repo = new PgDispositivoRepo(client);
    await repo.findActiveOwnerBySerialAndCanvasId('SN-UNIT-4', 4004);
    await repo.findActiveOwnerBySerialAndCanvasId('SN-UNIT-5', 5005);
    expect(calls).toHaveLength(2);
  });

  it('encodes every fail-closed predicate in the WHERE clause', async () => {
    const { client, calls } = makeMockClient({ rows: [] });
    const repo = new PgDispositivoRepo(client);
    await repo.findActiveOwnerBySerialAndCanvasId('SN-UNIT-6', 6006);
    const sql = calls[0]?.sql ?? '';
    // All four guards must appear in the single SQL — any omission
    // would be a security regression for B1.
    expect(sql).toMatch(/FROM\s+dispositivos\s+d/i);
    expect(sql).toMatch(/JOIN\s+students_cache\s+s\s+ON\s+s\.id\s*=\s*d\.assigned_student_id/i);
    expect(sql).toMatch(/d\.serial_number\s*=\s*\$1/);
    expect(sql).toMatch(/d\.status\s*=\s*'active'/i);
    expect(sql).toMatch(/s\.canvas_user_id\s*=\s*\$2/);
    expect(sql).toMatch(/s\.is_active\s*=\s*TRUE/i);
  });
});
