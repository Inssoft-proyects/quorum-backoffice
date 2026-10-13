/**
 * MFA `get-subject` service — S2S identity resolution.
 *
 * Given a marbete code + the device serial bound to the same
 * student, resolve the student's `canvas_user_id` (the OTP
 * subject) and SIS matrícula. This is the read-only half of the
 * MFA chain: it walks the SAME lookups the MFA authenticate flow
 * walks (steps 1–4 of `MfaAuthenticateService`) but stops BEFORE
 * the OTP verification and the session issuance.
 *
 * Policy order (mirrors `MfaAuthenticateService`):
 *
 *   1. Hash the input `marbete_code` (sha256, matching
 *      `marbetes.code_hash`).
 *   2. Look up the marbete by `code_hash`. Not found, soft-deleted,
 *      or `status != 'active'` → `deny.marbete_unknown`.
 *   3. `assigned_student_id IS NULL` → `deny.student_inactive`.
 *   4. Student lookup (`is_active = false` or missing) →
 *      `deny.student_inactive`.
 *   5. Device lookup by `serial_number`: unknown / revoked /
 *      unassigned → `deny.device_unknown`.
 *   6. Device assigned to a DIFFERENT student than the marbete →
 *      `deny.device_not_bound_to_student`.
 *   7. Return `{ canvasUserId, matricula }`.
 *
 * Why both factors (marbete + serial) even though there is NO OTP:
 * resolving a marbete to a student identity from the marbete code
 * ALONE would let a caller enumerate which student owns a marbete.
 * The paired device serial keeps the privacy posture of the full
 * MFA flow while dropping the OTP from this lookup.
 *
 * Side contracts:
 *
 *   - The raw marbete code and the raw serial are NEVER logged and
 *     NEVER echoed in the deny envelope — the service holds no
 *     logger at all, and the deny messages are the same static
 *     strings the MFA flow uses.
 *   - The deny envelope reuses `MfaAuthenticateError` so the route
 *     layer maps every MFA deny code through one path and the
 *     swagger `DenyEnvelope` enum stays the single taxonomy.
 *   - `matricula` is `students_cache.sis_id`, which is nullable
 *     for legacy/synthetic rows; it is passed through as-is (never
 *     coerced to '').
 */
import type pg from 'pg';
import { MfaAuthenticateError } from './mfa-authenticate-service';
import { hashMarbeteCode } from '../lib/marbete-code';
import {
  PgMfaRepo,
  type MfaMarbeteRow,
  type MfaStudentRow,
  type MfaDeviceRow,
} from '../repositories/pg-mfa-repo';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MfaGetSubjectInput {
  marbeteCode: string;
  serialNumber: string;
}

/**
 * Successful resolution. `canvasUserId` is the value the OTP is
 * bound to (`String(canvas_user_id)`); `matricula` is the SIS id
 * (nullable for legacy / synthetic high-privacy rows).
 */
export interface MfaGetSubjectResult {
  canvasUserId: number;
  matricula: string | null;
}

/**
 * The narrow read surface this service needs. Kept separate from
 * `MfaRepoLike` (which also exposes `insertStudentSession`) so the
 * unit fake implements exactly the three lookups the policy walks.
 * `PgMfaRepo` satisfies this structurally.
 */
export interface MfaGetSubjectRepoLike {
  findMarbeteByCodeHash(codeHash: string): Promise<MfaMarbeteRow | null>;
  findStudentById(id: number): Promise<MfaStudentRow | null>;
  findDeviceBySerialNumber(serialNumber: string): Promise<MfaDeviceRow | null>;
}

export interface MfaGetSubjectDeps {
  pool: pg.Pool;
  /**
   * Injectable repo factory — defaults to a real `PgMfaRepo` bound
   * to `pool`. The unit test passes a fake that pre-programs the
   * marbete / student / device lookups so the policy order is
   * exercised without a database.
   */
  repoFactory?: (client: pg.Pool | pg.PoolClient) => MfaGetSubjectRepoLike;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class MfaGetSubjectService {
  private readonly pool: pg.Pool;
  private readonly repoFactory: (client: pg.Pool | pg.PoolClient) => MfaGetSubjectRepoLike;

  constructor(deps: MfaGetSubjectDeps) {
    this.pool = deps.pool;
    this.repoFactory = deps.repoFactory ?? ((client) => new PgMfaRepo(client));
  }

  /**
   * Resolve the student identity bound to `(marbete, serial)`.
   * Throws `MfaAuthenticateError` on every documented deny path;
   * any other thrown error propagates to the route layer (which
   * maps it to `deny.dependency_fail` at 503).
   */
  async resolve(input: MfaGetSubjectInput): Promise<MfaGetSubjectResult> {
    const repo = this.repoFactory(this.pool);

    // (1) Hash the raw code. The hash is the only artifact that
    // touches the marbete table; the raw code is dropped and never
    // logged.
    const codeHash = hashMarbeteCode(input.marbeteCode);

    // (2) Marbete lookup. `findMarbeteByCodeHash` already filters
    // out `deleted_at IS NOT NULL` rows.
    const marbete = await repo.findMarbeteByCodeHash(codeHash);
    if (!marbete || marbete.status !== 'active') {
      throw new MfaAuthenticateError({
        code: 'deny.marbete_unknown',
        message: 'marbete is unknown or revoked',
      });
    }

    // (3) Student hydration from the marbete FK.
    if (marbete.assigned_student_id === null) {
      throw new MfaAuthenticateError({
        code: 'deny.student_inactive',
        message: 'marbete is not bound to an active student',
      });
    }
    const student = await repo.findStudentById(marbete.assigned_student_id);
    if (!student || !student.is_active) {
      throw new MfaAuthenticateError({
        code: 'deny.student_inactive',
        message: 'marbete is not bound to an active student',
      });
    }

    // (4) Device lookup + same-student binding. Unknown / revoked /
    // unbound collapses to `deny.device_unknown`; a device owned by
    // a different student is `deny.device_not_bound_to_student`.
    const device = await repo.findDeviceBySerialNumber(input.serialNumber);
    if (
      !device ||
      device.status !== 'active' ||
      device.revoked_at !== null ||
      device.assigned_student_id === null
    ) {
      throw new MfaAuthenticateError({
        code: 'deny.device_unknown',
        message: 'device is unknown, revoked, or unbound',
      });
    }
    if (device.assigned_student_id !== student.id) {
      throw new MfaAuthenticateError({
        code: 'deny.device_not_bound_to_student',
        message: 'device is bound to a different student than the marbete',
      });
    }

    // (5) Resolve. The subject is the canvas_user_id (NOT the
    // internal students_cache.id) so the caller issues/verifies OTPs
    // with the same wire identifier the MFA flow uses.
    return {
      canvasUserId: student.canvas_user_id,
      matricula: student.sis_id,
    };
  }
}
