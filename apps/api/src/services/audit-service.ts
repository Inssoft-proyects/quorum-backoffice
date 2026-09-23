/**
 * Audit service: appends entries to audit_log.
 *
 * The table is append-only by SQL (REVOKE UPDATE/DELETE FROM PUBLIC).
 * This service is the **only** writer. Reads happen in WU5 via a dedicated
 * query path.
 *
 * Each entry captures: actor, action, entity reference, optional before/after
 * JSONB diffs, the otp_id (when a destructive op was authorized), and the
 * request metadata (ip, user_agent).
 */
import type pg from 'pg';
import type { AuditAction } from '@quorum-backoffice/shared';

type Client = pg.Pool | pg.PoolClient;

export interface AuditWriteInput {
  actorId: string;
  actorEmail?: string | null;
  action: AuditAction;
  entityType?: string | null;
  entityId?: string | null;
  beforeJson?: unknown;
  afterJson?: unknown;
  otpId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export class AuditService {
  constructor(private readonly client: Client) {}

  async write(input: AuditWriteInput): Promise<void> {
    await this.client.query(
      `INSERT INTO audit_log
         (actor_id, actor_email, action, entity_type, entity_id,
          before_jsonb, after_jsonb, otp_id, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::inet, $10)`,
      [
        input.actorId,
        input.actorEmail ?? null,
        input.action,
        input.entityType ?? null,
        input.entityId ?? null,
        input.beforeJson === undefined ? null : JSON.stringify(input.beforeJson),
        input.afterJson === undefined ? null : JSON.stringify(input.afterJson),
        input.otpId ?? null,
        input.ip ?? null,
        input.userAgent ?? null,
      ],
    );
  }
}
