/**
 * PostgreSQL repository for the marbetes table.
 *
 * All queries are parameterized; the publicUid is the operator-facing id and
 * is the only field exposed by detail responses together with the masked
 * code. Raw code_hash is internal-only.
 */
import type pg from 'pg';
import type {
  MarbeteResponse,
  MarbeteStatus,
  ListMarbetesFilter,
} from '@quorum-backoffice/shared';

type Client = pg.Pool | pg.PoolClient;

export interface MarbeteRow {
  id: number;
  public_uid: string;
  status: MarbeteStatus;
  assigned_student_id: number | null;
  assigned_at: Date | null;
  created_at: Date;
  created_by: string;
  deleted_at: Date | null;
  deletion_reason: string | null;
}

function toResponse(row: MarbeteRow): MarbeteResponse {
  return {
    id: row.id,
    publicUid: row.public_uid,
    status: row.status,
    assignedStudentId: row.assigned_student_id,
    assignedAt: row.assigned_at ? row.assigned_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
    deletionReason: row.deletion_reason,
  };
}

export class PgMarbeteRepo {
  constructor(private readonly client: Client) {}

  async findById(id: number): Promise<MarbeteRow | null> {
    const r = await this.client.query<MarbeteRow>(
      `SELECT id, public_uid, status, assigned_student_id, assigned_at,
              created_at, created_by, deleted_at, deletion_reason
         FROM marbetes
        WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async findByPublicUid(publicUid: string): Promise<MarbeteRow | null> {
    const r = await this.client.query<MarbeteRow>(
      `SELECT id, public_uid, status, assigned_student_id, assigned_at,
              created_at, created_by, deleted_at, deletion_reason
         FROM marbetes
        WHERE public_uid = $1`,
      [publicUid],
    );
    return r.rows[0] ?? null;
  }

  async list(filter: ListMarbetesFilter): Promise<{ rows: MarbeteRow[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (filter.status) {
      where.push(`status = $${p++}`);
      params.push(filter.status);
    }
    if (filter.assigned === 'yes') {
      where.push(`assigned_student_id IS NOT NULL AND deleted_at IS NULL`);
    } else if (filter.assigned === 'no') {
      where.push(`(assigned_student_id IS NULL OR deleted_at IS NOT NULL)`);
    }
    if (filter.search) {
      where.push(`public_uid ILIKE $${p++}`);
      params.push(`%${filter.search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countSql = `SELECT count(*)::int AS total FROM marbetes ${whereSql}`;
    const countResult = await this.client.query<{ total: number }>(countSql, params);
    const total = countResult.rows[0]?.total ?? 0;
    const listSql = `SELECT id, public_uid, status, assigned_student_id, assigned_at,
                            created_at, created_by, deleted_at, deletion_reason
                       FROM marbetes ${whereSql}
                       ORDER BY created_at DESC
                       LIMIT $${p++} OFFSET $${p++}`;
    const listResult = await this.client.query<MarbeteRow>(listSql, [
      ...params,
      filter.limit,
      filter.offset,
    ]);
    return { rows: listResult.rows, total };
  }

  async counters(): Promise<{ ok: number; ko: number }> {
    // ok = active AND assigned to a student AND not soft-deleted.
    // ko = active AND NOT assigned OR soft-deleted.
    const r = await this.client.query<{ ok: number; ko: number }>(
      `SELECT
         count(*) FILTER (WHERE status = 'active' AND assigned_student_id IS NOT NULL AND deleted_at IS NULL)::int AS ok,
         count(*) FILTER (WHERE deleted_at IS NOT NULL OR (status = 'active' AND assigned_student_id IS NULL))::int AS ko
       FROM marbetes`,
    );
    return r.rows[0] ?? { ok: 0, ko: 0 };
  }

  async insert(args: {
    publicUid: string;
    codeHash: string;
    createdBy: string;
    assignedStudentId: number | null;
  }): Promise<MarbeteRow> {
    const r = await this.client.query<MarbeteRow>(
      `INSERT INTO marbetes (public_uid, code_hash, status, assigned_student_id, created_by)
       VALUES ($1, $2, 'active', $3, $4)
       RETURNING id, public_uid, status, assigned_student_id, assigned_at,
                 created_at, created_by, deleted_at, deletion_reason`,
      [args.publicUid, args.codeHash, args.assignedStudentId, args.createdBy],
    );
    const row = r.rows[0];
    if (!row) throw new Error('insert_failed');
    return row;
  }

  async assign(id: number, studentId: number | null): Promise<MarbeteRow | null> {
    const r = await this.client.query<MarbeteRow>(
      `UPDATE marbetes
          SET assigned_student_id = $2,
              assigned_at = CASE WHEN $2::bigint IS NULL THEN NULL ELSE now() END
        WHERE id = $1
        RETURNING id, public_uid, status, assigned_student_id, assigned_at,
                  created_at, created_by, deleted_at, deletion_reason`,
      [id, studentId],
    );
    return r.rows[0] ?? null;
  }

  async setStatus(id: number, status: MarbeteStatus): Promise<MarbeteRow | null> {
    const r = await this.client.query<MarbeteRow>(
      `UPDATE marbetes SET status = $2 WHERE id = $1
       RETURNING id, public_uid, status, assigned_student_id, assigned_at,
                 created_at, created_by, deleted_at, deletion_reason`,
      [id, status],
    );
    return r.rows[0] ?? null;
  }

  async softDelete(id: number, reason: string): Promise<MarbeteRow | null> {
    const r = await this.client.query<MarbeteRow>(
      `UPDATE marbetes
          SET deleted_at = now(),
              deletion_reason = $2,
              status = 'revoked',
              assigned_student_id = NULL
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, public_uid, status, assigned_student_id, assigned_at,
                  created_at, created_by, deleted_at, deletion_reason`,
      [id, reason],
    );
    return r.rows[0] ?? null;
  }

  async studentOf(studentId: number): Promise<{
    id: number;
    canvas_user_id: number;
    full_name: string;
    email: string;
  } | null> {
    const r = await this.client.query<{
      id: number;
      canvas_user_id: number;
      full_name: string;
      email: string;
    }>(
      `SELECT id, canvas_user_id, full_name, email
         FROM students_cache WHERE id = $1`,
      [studentId],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Bulk insert (WU #3 / Polish WU v4). Takes a `PoolClient` so the caller
   * can wrap it in BEGIN/COMMIT and keep the entire batch — including the
   * companion audit_log row — in a single transaction. Uses UNNEST for a
   * single round-trip regardless of batch size (capped at 200 by the DTO).
   *
   * No pre-flight duplicate check here; the service layer filters out
   * pre-existing code_hashes before calling so we avoid surfacing a 23505
   * to the operator. The CHECK constraint on `code_hash` still protects
   * against concurrent writers (serializable transaction would be needed
   * for full safety; the bulk endpoint is admin-only and not on a hot path).
   */
  async bulkInsert(
    client: pg.PoolClient,
    rows: { publicUid: string; codeHash: string; createdBy: string }[],
  ): Promise<MarbeteRow[]> {
    if (rows.length === 0) return [];
    const publicUids = rows.map((r) => r.publicUid);
    const codeHashes = rows.map((r) => r.codeHash);
    const createdBys = rows.map((r) => r.createdBy);
    // `status` is omitted so the column DEFAULT ('active') is preserved.
    // Explicitly listing a column with a default requires the SELECT to
    // produce a matching expression, which UNNEST() cannot do for a
    // constant across all rows without an extra array literal.
    const r = await client.query<MarbeteRow>(
      `INSERT INTO marbetes (public_uid, code_hash, created_by)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[])
       RETURNING id, public_uid, status, assigned_student_id, assigned_at,
                 created_at, created_by, deleted_at, deletion_reason`,
      [publicUids, codeHashes, createdBys],
    );
    return r.rows;
  }

  /**
   * Returns the subset of `codeHashes` that already exist in the marbetes
   * table. Used by `bulkCreate` to detect DB-side duplicates before
   * attempting the INSERT, so we can surface them as per-row failures
   * instead of a single 23505 aborting the entire batch.
   */
  async findExistingCodeHashes(codeHashes: string[]): Promise<string[]> {
    if (codeHashes.length === 0) return [];
    const r = await this.client.query<{ code_hash: string }>(
      `SELECT code_hash FROM marbetes WHERE code_hash = ANY($1::text[])`,
      [codeHashes],
    );
    return r.rows.map((row) => row.code_hash);
  }

  toResponse(row: MarbeteRow): MarbeteResponse {
    return toResponse(row);
  }
}
