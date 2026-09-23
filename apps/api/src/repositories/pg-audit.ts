/**
 * PostgreSQL repository for the audit_log table.
 *
 * Append-only by SQL (REVOKE UPDATE/DELETE FROM PUBLIC). This module owns
 * reads only; writes go through services/audit-service.ts.
 *
 * Mirrors the shape of pg-dispositivos.ts:
 *   - snake_case columns at the SQL/row boundary
 *   - camelCase fields in the response DTO
 *   - filter-by-fragment WHERE building for the list endpoint
 *
 * JSONB columns are selected via `::text` so the JSON payload always comes
 * back as a string regardless of the pg type-parser configuration. We
 * parse on the JS side in `toResponse`, producing a parsed value or null.
 *
 * The `entity_type` column is the single source of truth — the response
 * surfaces it directly and the list filter matches on it. The `auth.*`
 * action namespace stores `entity_type` as NULL (no domain entity
 * involved), which is exposed as `null` in the response.
 */
import type pg from 'pg';
import type {
  AuditEntry,
  AuditAction,
  ListAuditFilter,
} from '@quorum-backoffice/shared';

type Client = pg.Pool | pg.PoolClient;

export interface AuditRow {
  id: number;
  occurred_at: Date;
  actor_id: string;
  actor_email: string | null;
  action: AuditAction;
  entity_type: string | null;
  entity_id: string | null;
  before_jsonb: unknown;
  after_jsonb: unknown;
  otp_id: string | null;
  ip: string | null;
  user_agent: string | null;
}

function parseJsonbText(value: unknown): unknown | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}



function toResponse(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    actorId: row.actor_id,
    actorEmail: row.actor_email,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    beforeJson: parseJsonbText(row.before_jsonb),
    afterJson: parseJsonbText(row.after_jsonb),
    otpId: row.otp_id,
    ip: row.ip,
    userAgent: row.user_agent,
  };
}

export class PgAuditRepo {
  constructor(private readonly client: Client) {}

  async findById(id: number): Promise<AuditRow | null> {
    const r = await this.client.query<AuditRow>(
      `SELECT id, occurred_at, actor_id, actor_email, action,
              entity_type, entity_id,
              before_jsonb::text AS before_jsonb,
              after_jsonb::text  AS after_jsonb,
              otp_id, ip::text AS ip, user_agent
         FROM audit_log
        WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async list(filter: ListAuditFilter): Promise<{ rows: AuditRow[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (filter.entityType) {
      where.push(`entity_type = $${p++}`);
      params.push(filter.entityType);
    }
    if (filter.entityId) {
      where.push(`entity_id = $${p++}`);
      params.push(filter.entityId);
    }
    if (filter.actorId) {
      where.push(`actor_id = $${p++}`);
      params.push(filter.actorId);
    }
    if (filter.action) {
      // Cast column to text so the comparison is unambiguous against an enum.
      where.push(`action::text = $${p++}`);
      params.push(filter.action);
    }
    if (filter.since) {
      where.push(`occurred_at >= $${p++}`);
      params.push(filter.since);
    }
    if (filter.until) {
      where.push(`occurred_at <= $${p++}`);
      params.push(filter.until);
    }
    if (filter.search) {
      // Matches actor_id (operator id), entity_id (public id), or action name.
      where.push(
        `(actor_id ILIKE $${p} OR entity_id ILIKE $${p} OR action::text ILIKE $${p})`,
      );
      params.push(`%${filter.search}%`);
      p++;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countSql = `SELECT count(*)::int AS total FROM audit_log ${whereSql}`;
    const countResult = await this.client.query<{ total: number }>(countSql, params);
    const total = countResult.rows[0]?.total ?? 0;

    const listSql = `SELECT id, occurred_at, actor_id, actor_email, action,
                            entity_type, entity_id,
                            before_jsonb::text AS before_jsonb,
                            after_jsonb::text  AS after_jsonb,
                            otp_id, ip::text AS ip, user_agent
                       FROM audit_log ${whereSql}
                       ORDER BY occurred_at DESC
                       LIMIT $${p++} OFFSET $${p++}`;
    const listResult = await this.client.query<AuditRow>(listSql, [
      ...params,
      filter.limit,
      filter.offset,
    ]);
    return { rows: listResult.rows, total };
  }

  toResponse(row: AuditRow): AuditEntry {
    return toResponse(row);
  }
}
