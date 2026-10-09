/**
 * Zod DTOs for the audit log surface.
 *
 * Audit entries are appended (never updated) by the backoffice services.
 * The OTP middleware relies on `otp_id` being captured for every destructive
 * operation.
 */
import { z } from 'zod';

export const AuditAction = z.enum([
  'marbete.create',
  'marbete.update',
  'marbete.delete',
  'marbete.assign',
  // WU v3 / Asignación de marbetes: bulk + unassign actions.
  // SQL enum values added in migration 0013_matriculas.sql.
  'marbete.assign_bulk',
  'marbete.unassign',
  'marbete.reveal',
  'marbete.bulk_create',
  'dispositivo.create',
  'dispositivo.update',
  'dispositivo.revoke',
  // B2a: device assignment emits granular bind/release events;
  // the SQL labels must match the 0016 migration byte-for-byte.
  'dispositivo.assign',
  'dispositivo.unassign',
  'auth.login',
  'auth.logout',
  'auth.failed',
  // Polish WU v6: email + OTP login flow emits more granular auth events.
  'auth.login.requested',
  'auth.login.otp_verified',
  'auth.login.failed',
  // M1 / MFA authentication: every MFA attempt (allow OR deny)
  // emits a single 'student.mfa_authenticate' row so the operator
  // can reconcile the allow/deny distribution without joining on
  // any other table. The allow/deny discriminator is folded into
  // the after_jsonb `outcome` field (see mfa-authenticate-service).
  'student.mfa_authenticate',
  // M3 / MFA redirect-token consume: every successful S2S call
  // from Canvas to /api/v1/mfa/consume emits a single
  // 'student.mfa_consume' row so the operator can reconcile
  // token usage by canvas_user_id without joining on any other
  // table. The outcome (ok | mfa_token_invalid) is folded into
  // the after_jsonb `outcome` field. Migrations 0018 (auth)
  // and 0019 (consume) must be applied before the corresponding
  // service starts writing rows.
  'student.mfa_consume',
]);
export type AuditAction = z.infer<typeof AuditAction>;

export interface AuditEntry {
  id: number;
  occurredAt: string;
  actorId: string;
  actorEmail: string | null;
  action: AuditAction;
  entityType: string | null;
  entityId: string | null;
  beforeJson: unknown | null;
  afterJson: unknown | null;
  otpId: string | null;
  ip: string | null;
  userAgent: string | null;
}

export const ListAuditFilter = z.object({
  entityType: z.enum(['marbete', 'dispositivo', 'session']).optional(),
  entityId: z.string().min(1).max(64).optional(),
  actorId: z.string().min(1).max(64).optional(),
  action: AuditAction.optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  search: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListAuditFilter = z.infer<typeof ListAuditFilter>;

export interface ListAuditResponse {
  total: number;
  limit: number;
  offset: number;
  items: AuditEntry[];
}
