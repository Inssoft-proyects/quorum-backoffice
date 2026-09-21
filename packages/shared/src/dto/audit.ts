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
  'dispositivo.create',
  'dispositivo.update',
  'dispositivo.revoke',
  'auth.login',
  'auth.logout',
  'auth.failed',
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
