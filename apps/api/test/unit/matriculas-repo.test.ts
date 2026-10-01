/**
 * Unit tests for the matriculas repository layer.
 *
 * Focus:
 *   - filter→SQL mapping helpers (buildListMatriculasWhere):
 *     status, search, isActive predicates and their parameter
 *     counts.
 *   - upsertMany: inserted/updated split via xmax (mock pool).
 *
 * The listWithMarbetes / counters SQL is exercised end-to-end in
 * test/integration/matriculas.test.ts (which the parent task
 * directed us to write but not run on this host).
 */
import {
  buildListMatriculasWhere,
  PgMatriculasRepo,
} from '../../src/repositories/pg-matriculas';

describe('buildListMatriculasWhere', () => {
  it('defaults: status=any, isActive=true → only the isActive predicate', () => {
    const r = buildListMatriculasWhere({ limit: 50, offset: 0 });
    expect(r.params).toEqual([]);
    // `status=any` → no status predicate.
    expect(r.where.some((c) => c.includes('m.id IS'))).toBe(false);
    // `isActive=true` is the only default predicate.
    expect(r.where).toContain('s.is_active = TRUE');
  });

  it('status=assigned emits `m.id IS NOT NULL`', () => {
    const r = buildListMatriculasWhere({ limit: 50, offset: 0, status: 'assigned' });
    expect(r.where).toContain('m.id IS NOT NULL');
    expect(r.where.some((c) => c.includes('m.id IS NULL'))).toBe(false);
  });

  it('status=unassigned emits `m.id IS NULL`', () => {
    const r = buildListMatriculasWhere({ limit: 50, offset: 0, status: 'unassigned' });
    expect(r.where).toContain('m.id IS NULL');
    expect(r.where.some((c) => c.includes('m.id IS NOT NULL'))).toBe(false);
  });

  it('search emits a 3-way OR with two distinct params (ILIKE pattern + exact id)', () => {
    const r = buildListMatriculasWhere({ limit: 50, offset: 0, search: 'Alice' });
    expect(r.params).toEqual(['%Alice%', 'Alice']);
    expect(r.where).toHaveLength(2); // search + default isActive
    expect(r.where[0]).toMatch(/s\.full_name ILIKE \$1/);
    expect(r.where[0]).toMatch(/s\.email ILIKE \$1/);
    expect(r.where[0]).toMatch(/s\.canvas_user_id::text = \$2/);
  });

  it('isActive=false emits `s.is_active = FALSE`', () => {
    const r = buildListMatriculasWhere({ limit: 50, offset: 0, isActive: 'false' });
    expect(r.where).toContain('s.is_active = FALSE');
    expect(r.where.some((c) => c.includes('s.is_active = TRUE'))).toBe(false);
  });

  it('isActive=any emits no isActive predicate', () => {
    const r = buildListMatriculasWhere({ limit: 50, offset: 0, isActive: 'any' });
    expect(r.where.every((c) => !c.includes('s.is_active'))).toBe(true);
  });

  it('combines status + search + isActive=false without param drift', () => {
    const r = buildListMatriculasWhere({
      limit: 50,
      offset: 0,
      status: 'assigned',
      search: 'Bob',
      isActive: 'false',
    });
    expect(r.params).toEqual(['%Bob%', 'Bob']);
    expect(r.where).toEqual([
      'm.id IS NOT NULL',
      '(s.full_name ILIKE $1 OR s.email ILIKE $1 OR s.canvas_user_id::text = $2)',
      's.is_active = FALSE',
    ]);
  });
});

describe('PgMatriculasRepo.upsertMany', () => {
  interface CapturedSql {
    sql: string;
    params: unknown[];
  }

  function makeClient(opts: {
    /** xmax values to return in order — 0 means "inserted", anything else means "updated". */
    xmaxSequence: number[];
    captured?: CapturedSql[];
  }): import('pg').Pool {
    const captured = opts.captured ?? [];
    const queue = [...opts.xmaxSequence];
    const client = {
      async query<T extends { rows?: unknown[] }>(
        sql: string,
        params: unknown[] = [],
      ): Promise<T> {
        captured.push({ sql, params });
        if (/INSERT INTO students_cache/i.test(sql)) {
          const ids = params[0] as number[];
          const rows = ids.map((id) => ({
            canvas_user_id: id,
            xmax: queue.shift() ?? 0,
          }));
          return { rows } as unknown as T;
        }
        throw new Error(`unmocked_sql: ${sql}`);
      },
    };
    return client as unknown as import('pg').Pool;
  }

  it('empty input short-circuits to { inserted: 0, updated: 0 }', async () => {
    const client = makeClient({ xmaxSequence: [] });
    const repo = new PgMatriculasRepo(client);
    const r = await repo.upsertMany([]);
    expect(r).toEqual({ inserted: 0, updated: 0 });
  });

  it('classifies rows by xmax: 0 → inserted, non-zero → updated', async () => {
    const client = makeClient({ xmaxSequence: [0, 0, 42, 0, 99] });
    const repo = new PgMatriculasRepo(client);
    const r = await repo.upsertMany([
      { canvasUserId: 1, fullName: 'A', email: 'a@x' },
      { canvasUserId: 2, fullName: 'B', email: 'b@x' },
      { canvasUserId: 3, fullName: 'C', email: 'c@x' },
      { canvasUserId: 4, fullName: 'D', email: 'd@x' },
      { canvasUserId: 5, fullName: 'E', email: 'e@x' },
    ]);
    expect(r.inserted).toBe(3);
    expect(r.updated).toBe(2);
  });

  it('uses UNNEST + ON CONFLICT (canvas_user_id) DO UPDATE', async () => {
    const captured: CapturedSql[] = [];
    const client = makeClient({ xmaxSequence: [0], captured });
    const repo = new PgMatriculasRepo(client);
    await repo.upsertMany([
      { canvasUserId: 100, fullName: 'F', email: 'f@x' },
      { canvasUserId: 101, fullName: 'G', email: 'g@x' },
    ]);
    expect(captured).toHaveLength(1);
    const sql = captured[0]!.sql;
    expect(sql).toMatch(/INSERT INTO students_cache/i);
    expect(sql).toMatch(/UNNEST\(\$1::bigint\[\],\s*\$2::text\[\],\s*\$3::text\[\]\)/);
    expect(sql).toMatch(/ON CONFLICT \(canvas_user_id\) DO UPDATE/i);
    expect(sql).toMatch(/is_active = TRUE/i);
    expect(sql).toMatch(/last_synced_at = now\(\)/i);
    expect(captured[0]!.params).toEqual([
      [100, 101],
      ['F', 'G'],
      ['f@x', 'g@x'],
    ]);
  });
});