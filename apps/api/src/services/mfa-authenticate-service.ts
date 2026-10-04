/**
 * M1 / MFA authentication service.
 *
 * Pure orchestration layer over:
 *
 *   - `MfaRepo.findMarbeteByCodeHash(...)`  — looks up the marbete
 *     bound to the supplied sha256 hash of the raw marbete code.
 *   - `MfaRepo.findStudentById(...)`        — resolves
 *     `marbetes.assigned_student_id` to the students_cache row.
 *   - `MfaRepo.findDeviceBySerialNumber(...)` — looks up the device
 *     and checks it is bound to the SAME student the marbete
 *     points to.
 *   - `OtpClient.verify`                     — single-use OTP
 *     verified against the quorum-otp service, scope =
 *     MFA_AUTHENTICATE_OTP_SCOPE = 'mfa.access', subject =
 *     String(canvas_user_id).
 *   - `MfaRepo.insertStudentSession(...)`   — issues the
 *     `kind='student'` row in the `sessions` table.
 *   - `AuditService.write(...)`             — emits the single
 *     `student.mfa_authenticate` audit row that records the
 *     outcome (ok | deny.<code>).
 *
 * Policy order (must match the M1 plan in
 * `odd/tasks/canvas-jitsi-mfa-authentication.md`):
 *
 *   1. Hash the input `marbete_code` (sha256, matching the marbete
 *      table's `code_hash` column).
 *   2. Look up the marbete by `code_hash`. If not found, status
 *      != 'active', or `deleted_at IS NOT NULL` → `deny.marbete_unknown`.
 *      NEVER log the input code.
 *   3. Load the marbete's `assigned_student_id` (FK to
 *      `students_cache.id` per migration 0002). If NULL OR the
 *      student has `is_active = false` → `deny.student_inactive`.
 *   4. Look up the device by `serial_number`. If not found, status
 *      != 'active', `revoked_at IS NOT NULL`, or
 *      `assigned_student_id` does not match the marbete's student
 *      → `deny.device_unknown` (for the unknown / revoked paths)
 *      or `deny.device_not_bound_to_student` (for the wrong-owner
 *      path). NEVER log the serial.
 *   5. Call `OtpClient.verify` with
 *      `subject = String(canvas_user_id)` and
 *      `scope = 'mfa.access'`. Map: `ok=true` → continue;
 *      `ok=false, reason='invalid'` → `deny.otp_invalid`;
 *      `ok=false, reason='locked'` → `deny.lockout`;
 *      `ok=false, reason='unknown'` → `deny.dependency_fail`;
 *      thrown AppError / Error → `deny.dependency_fail`. NEVER log
 *      the OTP.
 *   6. Issue the session: insert into `sessions` with
 *      `kind='student'`, `canvas_user_id`, `role='student'`,
 *      `user_id=NULL`, the opaque session token, `expires_at`, `ip`,
 *      `user_agent`.
 *   7. Write the audit row (`action='student.mfa_authenticate'`,
 *      `entity_type='student'`, `entity_id=String(canvas_user_id)`,
 *      `actor='__mfa__'`, denormalized `student_name` / `student_email`
 *      in the JSONB `after_jsonb` field). The row NEVER contains the
 *      raw marbete code, the raw serial, or the raw OTP.
 *   8. Return the session payload (the route layer turns it into
 *      the response body + the `__Host-mfa_sid` cookie).
 *
 * Side contracts:
 *
 *   - The response payload (the MfaAuthenticateResult) is the only
 *     surface the route layer returns; the deny envelope the
 *     service throws is the source of truth for the HTTP code and
 *     the deny reason.
 *   - No raw code, serial, or OTP is logged at INFO / WARN / ERROR
 *     level. The `log.warn` lines on deny paths identify the
 *     deny code + the canvas_user_id (when known) + the ip; they
 *     never identify the device or the OTP.
 *   - The audit row identifies the student by their canvas_user_id
 *     (entity_id) and a denormalized name/email; the raw code /
 *     serial / OTP are not even present in the JSONB payload.
 */
import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import {
  AppError,
} from '../lib/errors';
import type { VerifyOtpResult } from '@quorum-backoffice/shared';
import { MFA_AUTHENTICATE_OTP_SCOPE } from '@quorum-backoffice/shared';
import { hashMarbeteCode } from '../lib/marbete-code';
import { generateSessionToken } from '../lib/session-token';
import { AuditService } from './audit-service';
import {
  PgMfaRepo,
  type MfaMarbeteRow,
  type MfaStudentRow,
  type MfaDeviceRow,
  type MfaStudentSessionRow,
} from '../repositories/pg-mfa-repo';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MfaAuthenticateInput {
  marbeteCode: string;
  serialNumber: string;
  otp: string;
}

export interface MfaAuthenticateMeta {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Successful authentication result. The route layer turns this
 * into the `MfaAuthenticateResponse` envelope + the
 * `__Host-mfa_sid` Set-Cookie header.
 *
 * `sessionToken` is the opaque token stored in the cookie and
 * returned in the response body; the JSON channel (M5) can use
 * the body value directly without a cookie store.
 */
export interface MfaAuthenticateResult {
  canvasUserId: number;
  studentName: string;
  studentEmail: string;
  sessionId: string;
  sessionToken: string;
  expiresAt: Date;
  session: MfaStudentSessionRow;
}

/**
 * Minimal OtpClient surface used by this service. The actual
 * `OtpClient` from `otp-client.ts` satisfies this contract;
 * the interface exists so the unit test can wire a deterministic
 * fake without spinning up the full client.
 */
export interface MfaOtpLike {
  verify(args: { subject: string; scope: string; code: string }): Promise<VerifyOtpResult>;
}

export interface MfaAuthenticateDeps {
  pool: pg.Pool;
  log: FastifyBaseLogger;
  otp: MfaOtpLike;
  sessionTtlSeconds: number;
  /**
   * Injectable repo factory — defaults to a real `PgMfaRepo` bound
   * to `pool`. The unit test passes a fake that pre-programs the
   * marbete / student / device lookups so the policy order is
   * exercised without a database.
   */
  repoFactory?: (client: pg.Pool | pg.PoolClient) => MfaRepoLike;
}

/**
 * The MFA repo's read+write surface, narrowed to just the methods
 * this service uses. Lets the unit test inject a `MfaRepoFake`
 * without depending on the real `PgMfaRepo` implementation.
 */
export interface MfaRepoLike {
  findMarbeteByCodeHash(codeHash: string): Promise<MfaMarbeteRow | null>;
  findStudentById(id: number): Promise<MfaStudentRow | null>;
  findDeviceBySerialNumber(serialNumber: string): Promise<MfaDeviceRow | null>;
  insertStudentSession(args: {
    id: string;
    canvasUserId: number;
    expiresAt: Date;
    ip: string | null;
    userAgent: string | null;
  }): Promise<MfaStudentSessionRow>;
}

/**
 * The deny envelope the route layer turns into the
 * MfaAuthenticateError HTTP envelope. Centralizes the mapping
 * from a deny reason to the wire code so the route layer stays
 * free of business logic.
 */
export interface MfaDeny {
  code:
    | 'deny.marbete_unknown'
    | 'deny.student_inactive'
    | 'deny.device_unknown'
    | 'deny.device_not_bound_to_student'
    | 'deny.otp_invalid'
    | 'deny.dependency_fail';
  message: string;
  details?: unknown;
}

/**
 * The single error type this service throws. The route layer
 * catches this and maps to the wire envelope; any other error
 * (TypeError, ReferenceError, etc.) propagates and is mapped
 * to `deny.dependency_fail` so a transient bug cannot leak
 * internals to the client.
 */
export class MfaAuthenticateError extends Error {
  readonly code: MfaDeny['code'];
  readonly details: unknown;
  constructor(deny: MfaDeny) {
    super(deny.message);
    this.name = 'MfaAuthenticateError';
    this.code = deny.code;
    this.details = deny.details;
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Stable actor id written to audit_log.actor_id on every MFA attempt. */
const MFA_AUDIT_ACTOR = '__mfa__';

export class MfaAuthenticateService {
  private readonly pool: pg.Pool;
  private readonly log: FastifyBaseLogger;
  private readonly otp: MfaOtpLike;
  private readonly sessionTtlSeconds: number;
  private readonly repoFactory: (client: pg.Pool | pg.PoolClient) => MfaRepoLike;

  constructor(deps: MfaAuthenticateDeps) {
    this.pool = deps.pool;
    this.log = deps.log;
    this.otp = deps.otp;
    this.sessionTtlSeconds = deps.sessionTtlSeconds;
    this.repoFactory =
      deps.repoFactory ?? ((client) => new PgMfaRepo(client));
  }

  /**
   * Run the MFA policy end-to-end. Returns the session payload on
   * success. Throws `MfaAuthenticateError` on every documented deny
   * path; any other thrown error is mapped to `deny.dependency_fail`
   * so a transient bug cannot leak an exception to the route layer.
   */
  async authenticate(
    input: MfaAuthenticateInput,
    meta: MfaAuthenticateMeta,
  ): Promise<MfaAuthenticateResult> {
    const repo = this.repoFactory(this.pool);
    try {
      // (1) Hash the input code. The hash is the only artifact that
      // ever touches the marbete table; the raw code is dropped
      // immediately and never logged.
      const codeHash = hashMarbeteCode(input.marbeteCode);

      // (2) Marbete lookup. `findMarbeteByCodeHash` already filters
      // out `deleted_at IS NOT NULL` rows, so any returned row is
      // either a live marbete or one whose status is not 'active'.
      const marbete = await repo.findMarbeteByCodeHash(codeHash);
      if (!marbete) {
        return this.deny(
          { code: 'deny.marbete_unknown', message: 'marbete is unknown or revoked' },
          null,
          null,
          meta,
        );
      }
      if (marbete.status !== 'active') {
        // Revoked / inactive marbete — collapse to the same deny code
        // as the unknown case so an attacker cannot enumerate which
        // codes are "valid but revoked" vs "missing".
        return this.deny(
          { code: 'deny.marbete_unknown', message: 'marbete is unknown or revoked' },
          null,
          null,
          meta,
        );
      }

      // (3) Student hydration. The marbete's `assigned_student_id`
      // is the FK to `students_cache.id` (per migration 0002). A
      // NULL FK is a marbete that was never bound to a student —
      // it cannot satisfy any MFA flow. `is_active = false` is the
      // standard "withdrawn / graduated" case.
      if (marbete.assigned_student_id === null) {
        return this.deny(
          { code: 'deny.student_inactive', message: 'marbete is not bound to an active student' },
          null,
          marbete,
          meta,
        );
      }
      const student = await repo.findStudentById(marbete.assigned_student_id);
      if (!student || !student.is_active) {
        return this.deny(
          { code: 'deny.student_inactive', message: 'marbete is not bound to an active student' },
          null,
          marbete,
          meta,
        );
      }

      // (4) Device lookup. The marbete → device binding is
      // enforced in a single pass:
      //   - serial unknown / revoked / unassigned   → deny.device_unknown
      //   - serial bound to a DIFFERENT student     → deny.device_not_bound_to_student
      const device = await repo.findDeviceBySerialNumber(input.serialNumber);
      if (
        !device ||
        device.status !== 'active' ||
        device.revoked_at !== null ||
        device.assigned_student_id === null
      ) {
        return this.deny(
          { code: 'deny.device_unknown', message: 'device is unknown, revoked, or unbound' },
          student,
          marbete,
          meta,
        );
      }
      if (device.assigned_student_id !== student.id) {
        return this.deny(
          {
            code: 'deny.device_not_bound_to_student',
            message: 'device is bound to a different student than the marbete',
          },
          student,
          marbete,
          meta,
        );
      }

      // (5) OTP verification. The subject is the canvas_user_id
      // (NOT the internal students_cache.id) so the OTP issuer
      // sees the same wire identifier the operator handed out.
      let otpResult: VerifyOtpResult;
      try {
        otpResult = await this.otp.verify({
          subject: String(student.canvas_user_id),
          scope: MFA_AUTHENTICATE_OTP_SCOPE,
          code: input.otp,
        });
      } catch {
        // AppError or bare Error from the OTP client → dependency
        // failure. Map uniformly so a transient transport error
        // cannot leak through the deny envelope.
        return this.deny(
          { code: 'deny.dependency_fail', message: 'OTP service unavailable' },
          student,
          marbete,
          meta,
        );
      }
      if (!otpResult.ok) {
        // 'invalid' and 'locked' are the canonical "wrong / replayed
        // / rate-limited" outcomes. 'unknown' (and any other reason
        // the OtpClient may grow in the future) collapses to
        // dependency_fail so a future OtpClient reason cannot
        // accidentally leak through the wire envelope.
        if (otpResult.reason === 'invalid') {
          return this.deny(
            { code: 'deny.otp_invalid', message: 'OTP is invalid or already consumed' },
            student,
            marbete,
            meta,
          );
        }
        if (otpResult.reason === 'locked') {
          return this.deny(
            { code: 'deny.dependency_fail', message: 'OTP subject is rate-limited' },
            student,
            marbete,
            meta,
          );
        }
        return this.deny(
          { code: 'deny.dependency_fail', message: 'OTP service rejected the code' },
          student,
          marbete,
          meta,
        );
      }

      // (6) Issue the session. The token is the same opaque base64url
      // 32-byte string the user session uses (see
      // lib/session-token.ts). The session row carries
      // kind='student', role='student', canvas_user_id, user_id=NULL.
      const sessionToken = generateSessionToken();
      const expiresAt = new Date(Date.now() + this.sessionTtlSeconds * 1000);
      const session = await repo.insertStudentSession({
        id: sessionToken,
        canvasUserId: student.canvas_user_id,
        expiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });

      // (7) Audit row. actor='__mfa__' (the MFA endpoint is the
      // actor — the student is the subject). entity_id is the
      // canvas_user_id (the same wire identifier the OTP was
      // bound to) so an operator can reconcile the event with
      // Canvas without joining on any other table.
      const audit = new AuditService(this.pool);
      await audit.write({
        actorId: MFA_AUDIT_ACTOR,
        action: 'student.mfa_authenticate',
        entityType: 'student',
        entityId: String(student.canvas_user_id),
        metadata: {
          outcome: 'ok',
          session_id: sessionToken.slice(0, 8),
          student_name: student.full_name,
          student_email: student.email,
        },
        otpId: otpResult.otpId,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });

      return {
        canvasUserId: student.canvas_user_id,
        studentName: student.full_name,
        studentEmail: student.email,
        sessionId: sessionToken,
        sessionToken,
        expiresAt,
        session,
      };
    } catch (err) {
      if (err instanceof MfaAuthenticateError) {
        throw err;
      }
      // Any other thrown error (DB outage, repository bug, …)
      // collapses to dependency_fail so a transient internal
      // failure cannot leak a stack trace to the route layer.
      this.log.error(
        { err: (err as Error).message, ip: meta.ip },
        'mfa_authenticate_unexpected_error',
      );
      throw new MfaAuthenticateError({
        code: 'deny.dependency_fail',
        message: 'mfa service unavailable',
      });
    }
  }

  /**
   * Write the deny audit row and throw the corresponding
   * `MfaAuthenticateError`. Centralized so the audit policy is
   * identical on every deny path. NEVER logs the raw marbete
   * code, the raw serial, or the raw OTP.
   */
  private async deny(
    deny: MfaDeny,
    student: MfaStudentRow | null,
    marbete: MfaMarbeteRow | null,
    meta: MfaAuthenticateMeta,
  ): Promise<never> {
    const audit = new AuditService(this.pool);
    await audit.write({
      actorId: MFA_AUDIT_ACTOR,
      action: 'student.mfa_authenticate',
      entityType: 'student',
      // Prefer the student-side canvas_user_id (when known) for
      // the audit `entity_id` so an operator can pivot the audit
      // log by canvas user. When the deny is BEFORE we know the
      // student (marbete_unknown), use the marbete's public_uid
      // so the row is still reconcilable with the marbete table.
      entityId:
        student !== null
          ? String(student.canvas_user_id)
          : marbete !== null
            ? marbete.public_uid
            : 'unknown',
      metadata: {
        outcome: deny.code,
        // Only the denormalized name/email; never the raw code,
        // the raw serial, or the raw OTP.
        ...(student !== null
          ? { student_name: student.full_name, student_email: student.email }
          : {}),
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    // Log at warn level so a denied attempt shows up in the log
    // stream but the log line never carries the raw code / serial
    // / OTP. The deny code is the operator's only signal.
    this.log.warn(
      {
        deny: deny.code,
        canvas_user_id: student?.canvas_user_id ?? null,
        ip: meta.ip,
      },
      'mfa_authenticate_denied',
    );

    throw new MfaAuthenticateError(deny);
  }
}

// Re-export AppError so the route layer (and the test suite) can
// import the deny-error contract from this module without an
// extra lib/ dependency. AppError itself is not used inside the
// service (MfaAuthenticateError is the only thrown shape), but
// re-exporting it keeps the import surface stable.
export { AppError };
