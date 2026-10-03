/**
 * B2a / Audit action registry — shared Zod enum mirror.
 *
 * The Postgres `audit_action` enum is the source of truth; the
 * TypeScript Zod `AuditAction` enum in
 * packages/shared/src/dto/audit.ts must mirror the SQL labels
 * byte-for-byte so the API never produces an event the database
 * will reject.
 *
 * This unit test (no DB required) asserts that the Zod enum accepts
 * the two device-assignment actions added by migration
 * 0016_audit_action_device_assignment.sql, and that the pre-existing
 * dispositivo.* values are still accepted.
 */
import { AuditAction } from '@quorum-backoffice/shared/dto/audit';

describe('AuditAction (shared Zod enum) — dispositivo.assign/unassign mirror', () => {
  it('accepts dispositivo.assign', () => {
    const r = AuditAction.safeParse('dispositivo.assign');
    expect(r.success).toBe(true);
  });

  it('accepts dispositivo.unassign', () => {
    const r = AuditAction.safeParse('dispositivo.unassign');
    expect(r.success).toBe(true);
  });

  it('still accepts the existing dispositivo.* values', () => {
    const existing = ['dispositivo.create', 'dispositivo.update', 'dispositivo.revoke'];
    for (const value of existing) {
      const r = AuditAction.safeParse(value);
      expect({ value, ok: r.success }).toEqual({ value, ok: true });
    }
  });

  it('exposes dispositivo.assign and dispositivo.unassign in its option list', () => {
    // byte-for-byte match with the SQL ALTER TYPE label
    expect(AuditAction.options).toEqual(
      expect.arrayContaining(['dispositivo.assign', 'dispositivo.unassign'])
    );
  });
});
