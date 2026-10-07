/**
 * Synthetic high-privacy student — DTO mapping contract (unit, mocked repo).
 *
 * The students_cache table now allows a row to be inserted with ONLY
 *   - canvas_user_id (the existing NOT NULL UNIQUE key)
 *   - sis_id        (the new nullable UNIQUE matrícula; required for
 *                     synthetic rows that carry no personal data)
 * and with NULL `full_name` / `email` (the migration drops the
 * NOT NULL constraints so synthetic test data can occupy the cache
 * without leaking personal information into test fixtures).
 *
 * This file locks the read-side contract for the students service:
 *   - `findByCanvasId` returns a row whose name/email are NULL
 *     → the service MUST map those to `null` in the DTO (NOT
 *       throw, NOT coerce to '' / undefined).
 *   - `sis_id` is surfaced on the DTO as `sisId` (string | null)
 *     so operators can correlate the synthetic row with the
 *     matrícula they used to seed it.
 *   - A row with the legacy shape (non-null name/email, no sis_id)
 *     continues to work; the change is backward compatible.
 *
 * These tests are pure (no PG, no Redis) — the repo is a typed
 * mock that returns the row bytes verbatim. The integration
 * suite in test/integration/students.test.ts exercises the same
 * contract end-to-end through Fastify.
 */
import type pg from 'pg';
import { StudentsService } from '../../src/services/students-service';
import type { StudentRow } from '../../src/repositories/pg-students';

interface RepoCall {
  sql: string;
  params: unknown[];
}

interface MockRepoOptions {
  row: StudentRow | null;
}

function makeMockPool(opts: MockRepoOptions): {
  pool: pg.Pool;
  calls: RepoCall[];
} {
  const calls: RepoCall[] = [];
  const pool = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return { rows: opts.row ? [opts.row] : [] };
    }),
  } as unknown as pg.Pool;
  return { pool, calls };
}

const SIBLINGS = {
  fullName: 'Marie Curie',
  email: 'marie-7@quorum.local',
} as const;

describe('StudentsService.findByCanvasId — synthetic high-privacy student (unit, mocked repo)', () => {
  it('maps a row with null full_name/email + non-null sis_id to a DTO with null name/email and the sisId', async () => {
    // The synthetic-row contract:
    //   - canvas_user_id stays NOT NULL UNIQUE (existing key)
    //   - sis_id is the new UNIQUE matrícula
    //   - full_name and email are intentionally NULL (no PII in test data)
    const syntheticRow: StudentRow = {
      id: 4242,
      canvas_user_id: 777_001,
      sis_id: 'ABC123',
      full_name: null,
      email: null,
      last_synced_at: new Date('2026-01-15T12:00:00Z'),
      is_active: true,
    };
    const { pool } = makeMockPool({ row: syntheticRow });
    const svc = new StudentsService({ pool });

    const result = await svc.findByCanvasId(777_001);

    expect(result).toEqual({
      id: 4242,
      canvasUserId: 777_001,
      sisId: 'ABC123',
      fullName: null,
      email: null,
      isActive: true,
    });
  });

  it('maps a legacy row (non-null name/email, null sis_id) backward-compatibly', async () => {
    // A row inserted the old way: name/email present, no sis_id.
    // The DTO must keep the non-null strings and surface sisId=null
    // so existing operator-facing flows are unchanged.
    const legacyRow: StudentRow = {
      id: 5151,
      canvas_user_id: 888_001,
      sis_id: null,
      full_name: SIBLINGS.fullName,
      email: SIBLINGS.email,
      last_synced_at: new Date('2026-01-15T12:00:00Z'),
      is_active: true,
    };
    const { pool } = makeMockPool({ row: legacyRow });
    const svc = new StudentsService({ pool });

    const result = await svc.findByCanvasId(888_001);

    expect(result).toEqual({
      id: 5151,
      canvasUserId: 888_001,
      sisId: null,
      fullName: SIBLINGS.fullName,
      email: SIBLINGS.email,
      isActive: true,
    });
  });

  it('throws 404 when the canvas_user_id is not in cache (unchanged)', async () => {
    const { pool } = makeMockPool({ row: null });
    const svc = new StudentsService({ pool });

    await expect(svc.findByCanvasId(999_999)).rejects.toMatchObject({
      code: 'not_found',
      httpStatus: 404,
    });
  });

  it('SELECT surfaces the sis_id column (read-side contract)', async () => {
    // Read-side contract: the repo query must include sis_id in the
    // SELECT list so the service mapper can forward it. Catching a
    // refactor that drops the column from the SELECT (and silently
    // nulls sisId in the DTO) is the point of this assertion.
    const row: StudentRow = {
      id: 1,
      canvas_user_id: 7,
      sis_id: 'XYZ789',
      full_name: null,
      email: null,
      last_synced_at: new Date('2026-01-15T12:00:00Z'),
      is_active: true,
    };
    const { pool, calls } = makeMockPool({ row });
    const svc = new StudentsService({ pool });

    await svc.findByCanvasId(7);

    expect(calls).toHaveLength(1);
    const sql = calls[0]?.sql ?? '';
    expect(sql).toMatch(/sis_id/);
    expect(calls[0]?.params).toEqual([7]);
  });
});
