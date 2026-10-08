/**
 * Unit tests for the matriculas repository layer.
 *
 * Focus:
 *   - filter→SQL mapping helpers (buildListMatriculasWhere):
 *     status, search, isActive predicates and their parameter
 *     counts.
 *   - listWithMarbetes: SELECT shape includes s.sis_id so the DTO
 *     can expose sisId to the UI; the marbete LEFT JOIN is
 *     preserved and pagination params are appended after the
 *     filter params.
 *   - upsertMany: inserted/updated split via xmax (mock pool).
 *
 * The listWithMarbetes / counters SQL is exercised end-to-end in
 * test/integration/matriculas.test.ts (which the parent task
 * directed us to write but not run on this host).
 */
import {
  buildListMatriculasWhere,
  PgMatriculasRepo,
  type ListMatriculasRow,
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

  it('search emits a 4-way OR with two distinct params (ILIKE pattern + exact id)', () => {
    const r = buildListMatriculasWhere({ limit: 50, offset: 0, search: 'Alice' });
    expect(r.params).toEqual(['%Alice%', 'Alice']);
    expect(r.where).toHaveLength(2); // search + default isActive
    expect(r.where[0]).toMatch(/s\.full_name ILIKE \$1/);
    expect(r.where[0]).toMatch(/s\.email ILIKE \$1/);
    expect(r.where[0]).toMatch(/s\.sis_id ILIKE \$1/);
    expect(r.where[0]).toMatch(/s\.canvas_user_id::text = \$2/);
  });

  it('search ILIKE on sis_id reuses the same %pattern% param as name/email', () => {
    // The sis_id arm shares $1 with full_name and email so the helper
    // stays a 2-param predicate (no extra param slot). The exact-id
    // match stays at $2.
    const r = buildListMatriculasWhere({ limit: 50, offset: 0, search: 'TOP' });
    expect(r.params).toEqual(['%TOP%', 'TOP']);
    // The same placeholder must appear for the sis_id arm.
    const searchClause = r.where[0]!;
    const ilikePlaceholders = (searchClause.match(/ILIKE \$\d+/g) ?? []).map(
      (s) => s.match(/\$\d+/)![0],
    );
    expect(ilikePlaceholders).toEqual(['$1', '$1', '$1']);
  });

  it('search without other filters emits search + isActive=true (2 predicates)', () => {
    const r = buildListMatriculasWhere({ limit: 50, offset: 0, search: 'ABC' });
    expect(r.where).toEqual([
      '(s.full_name ILIKE $1 OR s.email ILIKE $1 OR s.sis_id ILIKE $1 OR s.canvas_user_id::text = $2)',
      's.is_active = TRUE',
    ]);
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
      '(s.full_name ILIKE $1 OR s.email ILIKE $1 OR s.sis_id ILIKE $1 OR s.canvas_user_id::text = $2)',
      's.is_active = FALSE',
    ]);
  });
});

describe('PgMatriculasRepo.listWithMarbetes', () => {
  interface CapturedSql {
    sql: string;
    params: unknown[];
  }

  /**
   * Mock pool that captures every SQL statement. The COUNT query
   * returns total=0 unless `countRows` is provided; the LIST query
   * returns `listRows` and is matched by checking that the SQL
   * SELECTs from students_cache.
   */
  function makeListClient(opts: {
    listRows: ListMatriculasRow[];
    countRows?: { total: number }[];
    captured?: CapturedSql[];
  }): import('pg').Pool {
    const captured = opts.captured ?? [];
    const counts = [...(opts.countRows ?? [{ total: opts.listRows.length }])];
    const lists = [...opts.listRows];
    const client = {
      async query<T extends { rows?: unknown[] }>(
        sql: string,
        params: unknown[] = [],
      ): Promise<T> {
        captured.push({ sql, params });
        if (/SELECT count\(\*\)::int AS total/i.test(sql)) {
          return { rows: counts.shift() ?? [{ total: 0 }] } as unknown as T;
        }
        if (/FROM students_cache s/i.test(sql)) {
          const next = lists.shift();
          return { rows: next ? [next] : [] } as unknown as T;
        }
        throw new Error(`unmocked_sql: ${sql}`);
      },
    };
    return client as unknown as import('pg').Pool;
  }

  it('SELECTs s.sis_id so the DTO can expose sisId to the UI', async () => {
    const captured: CapturedSql[] = [];
    const client = makeListClient({
      listRows: [
        {
          id: 1,
          canvas_user_id: 12,
          // `full_name` / `email` use the SQL boundary type
          // (`StudentRow.full_name: string`); the null-name case is
          // the screen-level responsibility and is covered by
          // the `asociar-page-client` web test. Here we only need
          // to verify that the repo SELECTs and forwards `sis_id`.
          full_name: 'Placeholder',
          email: 'placeholder@example.com',
          sis_id: 'TOPGR4',
          last_synced_at: new Date('2024-09-12T10:00:00Z'),
          is_active: true,
          marbete_id: null,
          marbete_public_uid: null,
          marbete_status: null,
          marbete_assigned_at: null,
          marbete_assigned_by: null,
        },
      ],
      captured,
    });
    const repo = new PgMatriculasRepo(client);
    const { rows } = await repo.listWithMarbetes({
      status: 'any',
      isActive: 'true',
      limit: 50,
      offset: 0,
    });
    // The list query MUST select s.sis_id so toListItem in the
    // service can forward it. A regression to the pre-fix shape
    // (no sis_id SELECT) would break the contract immediately.
    // The list SQL is disambiguated from the count SQL by the
    // `ORDER BY` clause (the count query has no ORDER BY).
    const listSql = captured.find((c) => /ORDER BY s\.canvas_user_id/i.test(c.sql))!;
    expect(listSql.sql).toMatch(/s\.sis_id/);
    expect(listSql.sql).toMatch(/s\.full_name/);
    expect(listSql.sql).toMatch(/s\.email/);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sis_id).toBe('TOPGR4');
  });

  it('forwards the filter params + limit + offset to the list query', async () => {
    const captured: CapturedSql[] = [];
    const client = makeListClient({
      listRows: [],
      captured,
    });
    const repo = new PgMatriculasRepo(client);
    await repo.listWithMarbetes({
      status: 'unassigned',
      search: 'TOP',
      isActive: 'true',
      limit: 25,
      offset: 50,
    });
    // Two queries: count + list. The list query should carry the
    // 2 filter params + limit + offset = 4 params, and the limit /
    // offset should be appended at indexes 3 and 4 (after $1 and
    // $2 are taken by the search clause). Disambiguate by ORDER BY.
    const listSql = captured.find((c) => /ORDER BY s\.canvas_user_id/i.test(c.sql))!;
    expect(listSql.params).toEqual(['%TOP%', 'TOP', 25, 50]);
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
      { canvasUserId: 1, fullName: 'A', email: 'a@x', isActive: true },
      { canvasUserId: 2, fullName: 'B', email: 'b@x', isActive: true },
      { canvasUserId: 3, fullName: 'C', email: 'c@x', isActive: false },
      { canvasUserId: 4, fullName: 'D', email: 'd@x', isActive: true },
      { canvasUserId: 5, fullName: 'E', email: 'e@x', isActive: true },
    ]);
    expect(r.inserted).toBe(3);
    expect(r.updated).toBe(2);
  });

  it('uses UNNEST + ON CONFLICT (canvas_user_id) DO UPDATE with per-row is_active', async () => {
    const captured: CapturedSql[] = [];
    const client = makeClient({ xmaxSequence: [0], captured });
    const repo = new PgMatriculasRepo(client);
    await repo.upsertMany([
      { canvasUserId: 100, fullName: 'F', email: 'f@x', isActive: true },
      { canvasUserId: 101, fullName: 'G', email: 'g@x', isActive: false },
    ]);
    expect(captured).toHaveLength(1);
    const sql = captured[0]!.sql;
    expect(sql).toMatch(/INSERT INTO students_cache/i);
    // D-3 lock: the INSERT column list MUST have exactly 4
    // columns matching the 4 UNNEST arrays. The column DEFAULT
    // `now()` fills `last_synced_at` on insert; the ON CONFLICT
    // branch sets it to now() on update. A regression to the
    // 5-column / 4-UNNEST shape (the pre-fix production bug)
    // would break this assertion immediately.
    expect(sql).toMatch(
      /INSERT INTO students_cache\s*\(\s*canvas_user_id\s*,\s*full_name\s*,\s*email\s*,\s*is_active\s*\)/i,
    );
    expect(sql).not.toMatch(
      /INSERT INTO students_cache\s*\([^)]*last_synced_at/i,
    );
    expect(sql).toMatch(
      /UNNEST\(\$1::bigint\[\],\s*\$2::text\[\],\s*\$3::text\[\],\s*\$4::boolean\[\]\)/,
    );
    expect(sql).toMatch(/ON CONFLICT \(canvas_user_id\) DO UPDATE/i);
    // G9: ON CONFLICT branch uses the upstream is_active (so a
    // student who dropped out of Canvas lands inactive on the
    // next sync) rather than the blanket TRUE the pre-G9
    // upsert path used.
    expect(sql).toMatch(/is_active = EXCLUDED\.is_active/i);
    expect(sql).not.toMatch(/is_active = TRUE/i);
    expect(sql).toMatch(/last_synced_at = now\(\)/i);
    expect(captured[0]!.params).toEqual([
      [100, 101],
      ['F', 'G'],
      ['f@x', 'g@x'],
      [true, false],
    ]);
  });
});