/**
 * PostgreSQL repository for the "Asignación de marbetes" screen
 * (WU v3). Wraps `students_cache` together with the active-marbet
 * join needed by the list/counters endpoints and provides the
 * upsert path for the Canvas sync.
 *
 * Two responsibilities:
 *
 *   - listWithMarbetes / counters: read-only joins against
 *     students_cache + marbetes. Filters and pagination are applied
 *     here so the service layer only maps DTOs.
 *   - upsertMany: the FIRST write path into students_cache. Uses
 *     ON CONFLICT (canvas_user_id) DO UPDATE so an out-of-order
 *     sync page still converges. The sync flow sets `is_active=true`
 *     and `last_synced_at=now()` on every matched row.
 *   - deactivateMissing: the F4 follow-up deactivation path. After
 *     a COMPLETE Canvas roster walk, the service hands the full list
 *     of synced canvas_user_ids here to mark every cache row that
 *     is still active AND is NOT in the list as `is_active=false`.
 *     See the method doc-comment for the trade-off discussion.
 *
 * Naming: rows keep snake_case at the SQL boundary; the service
 * translates to camelCase DTOs. The public-API row type extends the
 * read-only `StudentRow` from pg-students.ts with the LEFT-JOINed
 * marbete fields so callers don't have to chase two interfaces.
 */
import type pg from 'pg';
import type {
  ListMatriculasFilter,
  MarbeteStatus,
} from '@quorum-backoffice/shared';
import type { StudentRow } from './pg-students';

type Client = pg.Pool | pg.PoolClient;

/** Plain Canvas row (no marbete join). Matches CanvasStudentListResponse.items[].
 *
 * G9 follow-up: `isActive` is the per-user enrollment status the
 * portal now publishes. The service forwards the upstream value
 * verbatim (defaulting to `true` for legacy portal builds that
 * omit the flag). The `email` column is the clear-text email the
 * portal publishes when PII minimisation is OFF; when the portal
 * omits it, the service stores the empty string.
 */
export interface CanvasStudentRow {
  canvasUserId: number;
  fullName: string;
  email: string;
  isActive: boolean;
}

/** Upsert outcome counts. Sum equals the row count at ingest time. */
export interface UpsertCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

/**
 * ListMatriculasRow: students_cache + marbetes LEFT JOIN (active
 * only). `marbete_id` is NULL when no active marbete is assigned.
 *
 * The `is_active` flag on students_cache mirrors Canvas enrollment
 * status (migration 0006_students_active.sql); the LEFT JOIN on
 * marbetes filters to `status='active' AND deleted_at IS NULL`.
 */
export interface ListMatriculasRow extends StudentRow {
  marbete_id: number | null;
  marbete_public_uid: string | null;
  marbete_status: MarbeteStatus | null;
  marbete_assigned_at: Date | null;
  marbete_assigned_by: string | null;
}

/**
 * Counters result: number of matrículas (under the active filter),
 * assigned vs unassigned, and the inventory pool of free marbetes.
 * The student-side numbers reflect the same `isActive` filter that
 * `listWithMarbetes` applies, so the UI's header counters never
 * disagree with the visible list.
 */
export interface CountersRow {
  total: number;
  assigned: number;
  unassigned: number;
  available_marbetes: number;
}

export interface FilterSql {
  where: string[];
  params: unknown[];
}

/**
 * Pure helper: turn a filter DTO into a `{ where, params }` fragment
 * so SQL builders (the list query + the count query) can share the
 * same predicates. Exported for unit testing — the route layer
 * never calls it directly.
 *
 * Accepts a partial input so the helper is testable without
 * round-tripping through Zod (the production call site always goes
 * through `ListMatriculasFilter.parse(req.query)` so defaults are
 * applied before the helper sees the object).
 *
 * Status filter:
 *   - 'assigned'   → `m.id IS NOT NULL` (LEFT JOIN matched)
 *   - 'unassigned' → `m.id IS NULL`
 *   - 'any' (default) → no status predicate
 *
 * Search filter: matches full_name ILIKE, email ILIKE, or an exact
 * canvas_user_id text match (so an operator can paste a numeric id
 * directly into the search box). The exact-id match uses a fresh
 * param slot so the SQL is self-documenting and matches the index
 * paths we expect (ILIKE on full_name/email, equality on
 * canvas_user_id).
 *
 * isActive filter:
 *   - 'true' (default) → only active students
 *   - 'false'          → only inactive students
 *   - 'any'            → no filter
 */
export function buildListMatriculasWhere(
  filter: Partial<ListMatriculasFilter>,
): FilterSql {
  const where: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  if (filter.status === 'assigned') {
    where.push('m.id IS NOT NULL');
  } else if (filter.status === 'unassigned') {
    where.push('m.id IS NULL');
  }
  if (filter.search) {
    where.push(
      `(s.full_name ILIKE $${p} OR s.email ILIKE $${p} OR s.canvas_user_id::text = $${p + 1})`,
    );
    params.push(`%${filter.search}%`);
    params.push(filter.search);
    p += 2;
  }
  // Mirror the DTO default (`'true'`) when the field is absent so the
  // helper is unit-testable without round-tripping through Zod.
  const isActive = filter.isActive ?? 'true';
  if (isActive === 'true') {
    where.push('s.is_active = TRUE');
  } else if (isActive === 'false') {
    where.push('s.is_active = FALSE');
  }
  return { where, params };
}

export class PgMatriculasRepo {
  constructor(private readonly client: Client) {}

  /**
   * Paginated listing with a LEFT JOIN onto the active marbete
   * assigned to each student. Returns `{ rows, total }` so the
   * service layer can assemble the list response without an extra
   * count round-trip.
   */
  async listWithMarbetes(filter: ListMatriculasFilter): Promise<{
    rows: ListMatriculasRow[];
    total: number;
  }> {
    const { where, params } = buildListMatriculasWhere(filter);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countSql = `
      SELECT count(*)::int AS total
        FROM students_cache s
        LEFT JOIN marbetes m
          ON m.assigned_student_id = s.id
         AND m.status = 'active'
         AND m.deleted_at IS NULL
        ${whereSql}
    `;
    const countResult = await this.client.query<{ total: number }>(
      countSql,
      params,
    );
    const total = countResult.rows[0]?.total ?? 0;

    // Stable ordering by canvas_user_id so the UI sees a
    // deterministic page-to-page order even when names collide.
    const listSql = `
      SELECT s.id, s.canvas_user_id, s.full_name, s.email,
             s.last_synced_at, s.is_active,
             m.id              AS marbete_id,
             m.public_uid      AS marbete_public_uid,
             m.status          AS marbete_status,
             m.assigned_at     AS marbete_assigned_at,
             m.assigned_by     AS marbete_assigned_by
        FROM students_cache s
        LEFT JOIN marbetes m
          ON m.assigned_student_id = s.id
         AND m.status = 'active'
         AND m.deleted_at IS NULL
        ${whereSql}
       ORDER BY s.canvas_user_id ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const listResult = await this.client.query<ListMatriculasRow>(listSql, [
      ...params,
      filter.limit,
      filter.offset,
    ]);
    return { rows: listResult.rows, total };
  }

  /**
   * Aggregate counters for the screen header. Filters apply to
   * the student side only; availableMarbetes is a global pool count
   * because an admin needs to know how many marbetes are free to
   * assign regardless of which student the dialog will target.
   *
   * The isActive filter mirrors `listWithMarbetes` so the UI's
   * "Total" matches the visible rows exactly.
   */
  async counters(filter: ListMatriculasFilter): Promise<CountersRow> {
    const { where, params } = buildListMatriculasWhere(filter);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const studentsSql = `
      SELECT
        count(*)::int                                                                                  AS total,
        count(*) FILTER (WHERE m.id IS NOT NULL)::int                                                  AS assigned,
        count(*) FILTER (WHERE m.id IS NULL)::int                                                      AS unassigned
        FROM students_cache s
        LEFT JOIN marbetes m
          ON m.assigned_student_id = s.id
         AND m.status = 'active'
         AND m.deleted_at IS NULL
        ${whereSql}
    `;
    const students = await this.client.query<{
      total: number;
      assigned: number;
      unassigned: number;
    }>(studentsSql, params);

    // Independent count: free marbetes are a property of the
    // inventory, not the student filter. Keeping it in the same
    // query round-trip keeps the /counters endpoint single-call.
    const freeSql = `
      SELECT count(*)::int AS available_marbetes
        FROM marbetes
       WHERE status = 'active'
         AND deleted_at IS NULL
         AND assigned_student_id IS NULL
    `;
    const free = await this.client.query<{ available_marbetes: number }>(
      freeSql,
    );

    const row = students.rows[0] ?? { total: 0, assigned: 0, unassigned: 0 };
    return {
      total: row.total,
      assigned: row.assigned,
      unassigned: row.unassigned,
      available_marbetes: free.rows[0]?.available_marbetes ?? 0,
    };
  }

  /**
   * Bulk upsert from a Canvas page. ON CONFLICT (canvas_user_id)
   * updates `full_name`, `email`, `is_active` (per-row value from
   * the upstream payload), and `last_synced_at=now()` for every
   * matched row.
   *
   * G9 follow-up: the `is_active` column is now driven by the
   * upstream payload (per-row, defaults to TRUE at the service
   * layer when the portal omits the flag). The ON CONFLICT
   * branch uses `EXCLUDED.is_active` so a row that flipped to
   * `false` in Canvas is reflected on the next sync.
   *
   * The function counts inserted vs updated vs unchanged by
   * inspecting `xmax`:
   *
   *   - xmax = 0          → brand-new row (INSERT)
   *   - xmax <> 0, xmax <> current xid  → row was updated
   *   - xmax = current xid → no-op (the WHERE matched but no
   *                          column actually changed)
   *
   * We rely on the standard Postgres trick (xmax = 0 = inserted,
   * otherwise updated). The "unchanged" branch is what we
   * classify rows where the SET would have produced an identical
   * payload — Postgres still returns them as updated, so we
   * compare the inferred vs the prior full_name / email / active
   * flags via a second SELECT on the same canvas_user_ids. To
   * keep this function to a single round-trip we instead compare
   * in JS using the input rows vs a small pre-read; that pre-read
   * lives in the service layer (Canvas sync uses the call site's
   * already-loaded Canvas page to compute the diff), and this
   * repo method returns the raw INSERTED/UPDATED split.
   *
   * `skipped` is for caller-side classification (e.g. rows the
   * caller considers invalid/inactive and chooses not to forward
   * here). This repo does NOT skip rows on its own — it processes
   * every row it receives.
   */
  async upsertMany(rows: CanvasStudentRow[]): Promise<{
    inserted: number;
    updated: number;
  }> {
    if (rows.length === 0) return { inserted: 0, updated: 0 };

    const canvasIds = rows.map((r) => r.canvasUserId);
    const fullNames = rows.map((r) => r.fullName);
    const emails = rows.map((r) => r.email);
    const isActives = rows.map((r) => r.isActive);

    // `xmax = 0` is the standard "INSERT" sentinel returned by
    // RETURNING after ON CONFLICT DO UPDATE. The other rows are
    // updates (no separate "unchanged" signal at the SQL level).
    //
    // D-3 fix: the INSERT column list omits `last_synced_at` so the
    // column DEFAULT `now()` fires on insert. The ON CONFLICT branch
    // still sets `last_synced_at = now()` so updated rows get a
    // fresh timestamp. The 4 target columns line up 1:1 with the 4
    // UNNEST arrays.
    const r = await this.client.query<{ canvas_user_id: number; xmax: number }>(
      `INSERT INTO students_cache (canvas_user_id, full_name, email, is_active)
       SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::boolean[])
       ON CONFLICT (canvas_user_id) DO UPDATE
         SET full_name = EXCLUDED.full_name,
             email = EXCLUDED.email,
             is_active = EXCLUDED.is_active,
             last_synced_at = now()
       RETURNING canvas_user_id, xmax`,
      [canvasIds, fullNames, emails, isActives],
    );

    let inserted = 0;
    let updated = 0;
    for (const row of r.rows) {
      if (row.xmax === 0) inserted += 1;
      else updated += 1;
    }
    return { inserted, updated };
  }

  /**
   * F4 follow-up: deactivate cached rows missing from the latest
   * Canvas roster walk.
   *
   * Single UPDATE statement with a `NOT (canvas_user_id = ANY($1))`
   * predicate. Efficient enough for the 20k sync cap: the `id =` index
   * family + the bitmap-OR of the negated ANY array keep the planner on
   * a sequential scan over `students_cache` (the table is small at
   * 20k rows). The trade-off — one UPDATE per complete sync instead
   * of a per-row DELETE — is documented in the parent task: we want
   * the "missing from the roster" transition to converge in O(1)
   * round-trips, not O(N).
   *
   * `last_synced_at` is bumped to `now()` for deactivated rows too:
   * the row DID receive a sync event (the "you're gone" event), and
   * keeping the timestamp fresh means a UI filter "synced in the last
   * 24h" still surfaces a clean state to operators.
   *
   * Pre-condition (caller-enforced): `canvasUserIds` is the COMPLETE
   * set of ids the latest sync ingested. If the caller passes an
   * incomplete list, this method will deactivate rows that are
   * still active in Canvas — the service guards against this by only
   * calling it when the loop walked every Canvas row (see
   * `MatriculasService.sync`).
   *
   * Returns the number of rows actually flipped to `is_active=false`
   * (pg returns this from the UPDATE ... SET rowCount).
   */
  async deactivateMissing(canvasUserIds: number[]): Promise<number> {
    // Empty array → negation matches every active row → would mark
    // the entire cache inactive. Guard at the repo level because the
    // service-level guard (`total > 0`) can change in future
    // refactors without the test suite noticing.
    if (canvasUserIds.length === 0) return 0;

    const r = await this.client.query(
      `UPDATE students_cache
          SET is_active = FALSE,
              last_synced_at = now()
        WHERE is_active = TRUE
          AND NOT (canvas_user_id = ANY($1::bigint[]))`,
      [canvasUserIds],
    );
    return r.rowCount ?? 0;
  }
}