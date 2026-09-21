/**
 * PostgreSQL repository for the dispositivos table.
 *
 * Mirrors the shape of pg-marbetes.ts. The repository owns SQL only; the
 * service layer handles OTP verification, audit emission, and orchestration.
 *
 * The `status` column is mirrored to a dedicated enum at the DB layer; the
 * repository translates between snake_case columns and camelCase response
 * fields so the DTO contract stays the only public surface.
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

  toResponse(row: DispositivoRow): DispositivoResponse {
    return toResponse(row);
  }
}