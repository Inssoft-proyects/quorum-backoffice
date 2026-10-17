/**
 * MFA `get-subject` service — S2S identity resolution.
 *
 * Given a marbete code + an approved device serial, resolve the
 * student's `canvas_user_id` (the OTP subject) and SIS matrícula.
 * This is the read-only half of the MFA chain: it walks the SAME
 * lookups the MFA authenticate flow walks but stops BEFORE the OTP
 * verification and the session issuance.
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
 *   5. Device lookup by `serial_number`: unknown / revoked →
 *      `deny.device_unknown`.
 *   6. B5 / S5 fail-closed matrícula gate: if the resolved
 *      student's `sis_id IS NULL`, deny with
 *      `deny.dependency_fail`. Mirrors `MfaAuthenticateService`
 *      step 5 — the gate runs AFTER the device check (so only
 *      authorized callers learn the row is missing the
 *      matrícula) and BEFORE the resolve returns. The caller
 *      (typically a S2S caller that issues OTPs) MUST NOT see
 *      `{ canvasUserId, matricula: null }` because a `null`
 *      matrícula would yield an OTP without a Jitsi display name.
 *   7. Return `{ canvasUserId, matricula }`.
 *
 * The device is an AUTHORIZATION factor, not an identity factor: a
 * shared classroom device must be active + non-revoked (a member of
 * the approved-device allowlist), but it is NOT bound to a specific
 * student. Identity comes from the marbete (which student) and, in
 * the full MFA flow, the OTP (proof of that student). Keeping the
 * serial as a required input preserves the privacy posture: a caller
 * cannot resolve a marbete to a student with the marbete code ALONE.
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

    // (4) Device lookup. The device is an authorization factor (a
    // shared "approved device" allowlist), not an identity factor:
    // active + non-revoked is enough, regardless of any student
    // assignment (shared classroom pool).
    const device = await repo.findDeviceBySerialNumber(input.serialNumber);
    if (!device || device.status !== 'active' || device.revoked_at !== null) {
      throw new MfaAuthenticateError({
        code: 'deny.device_unknown',
        message: 'device is unknown or revoked',
      });
    }

    // (5) B5 / S5 fail-closed matrícula gate. A student whose
    // `students_cache.sis_id` is NULL (legacy / synthetic row
    // whose matrícula was never back-filled) MUST NOT be
    // resolved as `{ canvasUserId, matricula: null }` — the
    // caller (the S2S service that issues OTPs) would issue
    // an OTP for a student the Jitsi proxy cannot label.
    // Deny with `deny.dependency_fail` so the route
    // propagates the operator-visible fail-closed signal.
    if (student.sis_id === null) {
      throw new MfaAuthenticateError({
        code: 'deny.dependency_fail',
        message: 'student matrícula (sis_id) is not available',
      });
    }

    // (6) Resolve. The subject is the canvas_user_id (NOT the
    // internal students_cache.id) so the caller issues/verifies OTPs
    // with the same wire identifier the MFA flow uses.
    return {
      canvasUserId: student.canvas_user_id,
      matricula: student.sis_id,
    };
  }
}
