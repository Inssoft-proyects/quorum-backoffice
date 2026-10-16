/**
 * PostgreSQL repository for the dispositivos table.
 *
 * Mirrors the shape of pg-marbetes.ts. The repository owns SQL only; the
 * service layer handles OTP verification, audit emission, and orchestration.
 *
 * The `status` column is mirrored to a dedicated enum at the DB layer; the
 * repository translates between snake_case columns and camelCase response
 * fields so the DTO contract stays the only public surface.
 *
 * Fase 2 / dispositivos-assignment-retirement:
 *   - The `assigned_student_id` column was dropped by migration 0022; this
 *     module no longer reads or writes it.
 *   - The previous `assignStudent()` write method is retired (the assign /
 *     unassign routes are gone with it).
 *   - `findActiveOwnerBySerialAndCanvasId` is INTENTIONALLY preserved: the
 *     shared-device allowlist model resolves the device by
 *     `s.canvas_user_id=$2`, never by the (now-gone) device→student FK.
 */
import type pg from 'pg';
import type {
  DispositivoResponse,
  DispositivoStatus,
  ListDispositivosFilter,
} from '@quorum-backoffice/shared';

type Client = pg.Pool | pg.PoolClient;

export interface DispositivoRow {
  id: number;
  serial_number: string;
  brand: string | null;
  model: string | null;
  status: DispositivoStatus;
  created_at: Date;
  created_by: string;
  revoked_at: Date | null;
  revoked_reason: string | null;
}

/**
 * Result of a shared-device resolution check.
 *
 * `owner` is the only field the caller's access decision consumes. It is
 * `true` ONLY when every fail-closed predicate holds:
 *
 *   - the device row exists for the supplied serial_number,
 *   - the device status is `active` and not soft-revoked,
 *   - the student with the supplied `canvas_user_id` is active in
 *     `students_cache` (`is_active = TRUE`).
 *
 * The device is an authorization factor (approved allowlist), NOT bound
 * to a student — phase 2 retired `dispositivos.assigned_student_id` and
 * the column is no longer consulted (or even present) in this query.
 * `studentId` is the internal `students_cache.id` (NOT the canvas user
 * id, NOT the serial) resolved from the supplied canvas_user_id, returned
 * only on success. It is a bare numeric id so it can be logged or audited
 * without leaking the device serial. The serial is never echoed on purpose:
 * a denied caller must not be able to enumerate devices.
 *
 * Negative answers are uniformly `{ owner: false, studentId: null }` —
 * the repository does not distinguish "device does not exist" from
 * "device revoked" from "student missing/inactive", because the caller
 * should treat all identically (deny).
 */
export interface DeviceOwnerCheck {
  owner: boolean;
  studentId: number | null;
}

function toResponse(row: DispositivoRow): DispositivoResponse {
  return {
    id: row.id,
    serialNumber: row.serial_number,
    brand: row.brand,
    model: row.model,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    revokedReason: row.revoked_reason,
  };
}

export class PgDispositivoRepo {
  constructor(private readonly client: Client) {}

  async findById(id: number): Promise<DispositivoRow | null> {
    const r = await this.client.query<DispositivoRow>(
      `SELECT id, serial_number, brand, model, status, created_at, created_by,
              revoked_at, revoked_reason
         FROM dispositivos
        WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async findBySerialNumber(serialNumber: string): Promise<DispositivoRow | null> {
    const r = await this.client.query<DispositivoRow>(
      `SELECT id, serial_number, brand, model, status, created_at, created_by,
              revoked_at, revoked_reason
         FROM dispositivos
        WHERE serial_number = $1`,
      [serialNumber],
    );
    return r.rows[0] ?? null;
  }

  async list(filter: ListDispositivosFilter): Promise<{ rows: DispositivoRow[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (filter.status) {
      where.push(`status = $${p++}`);
      params.push(filter.status);
    }
    if (filter.search) {
      where.push(`serial_number ILIKE $${p++}`);
      params.push(`%${filter.search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countSql = `SELECT count(*)::int AS total FROM dispositivos ${whereSql}`;
    const countResult = await this.client.query<{ total: number }>(countSql, params);
    const total = countResult.rows[0]?.total ?? 0;
    const listSql = `SELECT id, serial_number, brand, model, status, created_at, created_by,
                            revoked_at, revoked_reason
                       FROM dispositivos ${whereSql}
                       ORDER BY created_at DESC
                       LIMIT $${p++} OFFSET $${p++}`;
    const listResult = await this.client.query<DispositivoRow>(listSql, [
      ...params,
      filter.limit,
      filter.offset,
    ]);
    return { rows: listResult.rows, total };
  }

  async insert(args: {
    serialNumber: string;
    brand: string | null;
    model: string | null;
    createdBy: string;
  }): Promise<DispositivoRow> {
    const r = await this.client.query<DispositivoRow>(
      `INSERT INTO dispositivos (serial_number, brand, model, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, serial_number, brand, model, status, created_at, created_by,
                 revoked_at, revoked_reason`,
      [args.serialNumber, args.brand, args.model, args.createdBy],
    );
    const row = r.rows[0];
    if (!row) throw new Error('insert_failed');
    return row;
  }

  async update(
    id: number,
    args: { brand?: string | null; model?: string | null },
  ): Promise<DispositivoRow | null> {
    // COALESCE keeps existing value if arg is undefined; explicit null clears it.
    const r = await this.client.query<DispositivoRow>(
      `UPDATE dispositivos
          SET brand = COALESCE($2, brand),
              model = COALESCE($3, model)
        WHERE id = $1
        RETURNING id, serial_number, brand, model, status, created_at, created_by,
                  revoked_at, revoked_reason`,
      [id, args.brand ?? null, args.model ?? null],
    );
    return r.rows[0] ?? null;
  }

  async softRevoke(id: number, reason: string): Promise<DispositivoRow | null> {
    const r = await this.client.query<DispositivoRow>(
      `UPDATE dispositivos
          SET revoked_at = now(),
              revoked_reason = $2,
              status = 'revoked'
        WHERE id = $1 AND status = 'active'
        RETURNING id, serial_number, brand, model, status, created_at, created_by,
                  revoked_at, revoked_reason`,
      [id, reason],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Logical-delete model: reactivate a revoked device (un-revoke / re-register
   * over the same row). Only `status`, `revoked_at`, `revoked_reason`, and the
   * optional brand/model are touched — `created_at`/`created_by` (first
   * registration identity) are intentionally left untouched, so the
   * physical device keeps one stable row and the audit trail never dangles.
   */
  async reactivate(
    id: number,
    args: { brand?: string | null; model?: string | null },
  ): Promise<DispositivoRow | null> {
    const r = await this.client.query<DispositivoRow>(
      `UPDATE dispositivos
          SET status = 'active',
              revoked_at = NULL,
              revoked_reason = NULL,
              brand = COALESCE($2, brand),
              model = COALESCE($3, model)
        WHERE id = $1 AND status = 'revoked'
        RETURNING id, serial_number, brand, model, status, created_at, created_by,
                  revoked_at, revoked_reason`,
      [id, args.brand ?? null, args.model ?? null],
    );
    return r.rows[0] ?? null;
  }

  /**
   * B1 / Shared-device authorization: read-only resolution check.
   *
   * Single SQL join that covers every fail-closed predicate in one
   * round-trip. The device is an AUTHORIZATION factor (a shared
   * "approved device" allowlist), NOT an identity factor — it is not
   * bound to a student. The WHERE clause encodes:
   *
   *   - serial match (parameter $1)
   *   - device status = 'active' (revoked devices cannot authenticate)
   *   - device revoked_at IS NULL (soft-revoked devices deny)
   *   - students_cache.is_active = TRUE (graduated/withdrawn deny)
   *   - canvas_user_id match (parameter $2, resolves the student id)
   *
   * The INNER JOIN drops rows that fail any status predicate, so a
   * missing student, a revoked device, and a mismatched canvas_user_id
   * all collapse into the same "no row" outcome. The device is never
   * required to be assigned to that student (shared classroom pool).
   *
   * Returning a single boolean (plus the resolved student id) keeps
   * the surface minimal: callers get `{ owner: true, studentId }` on
   * success or `{ owner: false, studentId: null }` on any deny — no
   * enum of failure modes to leak, and no serial in the result.
   */
  async findActiveOwnerBySerialAndCanvasId(
    serialNumber: string,
    canvasUserId: number,
  ): Promise<DeviceOwnerCheck> {
    const r = await this.client.query<{ student_id: string }>(
      `SELECT s.id AS student_id
         FROM dispositivos d
         JOIN students_cache s ON s.canvas_user_id = $2
        WHERE d.serial_number = $1
          AND d.status        = 'active'
          AND d.revoked_at    IS NULL
          AND s.is_active     = TRUE`,
      [serialNumber, canvasUserId],
    );
    const row = r.rows[0];
    if (!row) return { owner: false, studentId: null };
    return { owner: true, studentId: Number(row.student_id) };
  }

  toResponse(row: DispositivoRow): DispositivoResponse {
    return toResponse(row);
  }
}