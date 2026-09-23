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
 *
 * WU #1 (reveal) adds a single optional `metadata` field on the write input.
 * It is folded into the existing `after_jsonb` JSONB column at INSERT time
 * (no schema migration), so callers that don't pass it see no behavior
 * change.
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
  /**
   * Optional free-form JSONB payload. When provided together with no
   * `afterJson`, the payload is written into the `after_jsonb` column so
   * audit reads can access it via `after_jsonb->>...`. When both
   * `metadata` and `afterJson` are provided, `afterJson` wins (existing
   * behaviour for state-change audits).
   */
  metadata?: Record<string, unknown>;
  afterJson?: unknown;
  otpId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export class AuditService {
  constructor(private readonly client: Client) {}

  async write(input: AuditWriteInput): Promise<void> {
    const afterJson =
      input.afterJson !== undefined
        ? input.afterJson
        : input.metadata !== undefined
          ? input.metadata
          : undefined;
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
        afterJson === undefined ? null : JSON.stringify(afterJson),
        input.otpId ?? null,
        input.ip ?? null,
        input.userAgent ?? null,
      ],
    );
  }
}
