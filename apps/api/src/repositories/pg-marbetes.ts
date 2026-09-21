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

  toResponse(row: MarbeteRow): MarbeteResponse {
    return toResponse(row);
  }
}
