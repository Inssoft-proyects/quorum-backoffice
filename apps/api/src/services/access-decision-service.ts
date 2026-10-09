/**
 * B3.2 / Machine-to-machine access-decision service.
 *
 * Pure orchestration layer over:
 *   - `OtpClient.verify`  — single-use OTP verified against the
 *                           quorum-otp service, scope =
 *                           ACCESS_DECISION_OTP_SCOPE.
 *   - `checkOwner(...)`   — fail-closed owner lookup against the
 *                           `dispositivos` + `students_cache`
 *                           join. Returns `{ owner, studentId }`
 *                           where negative answers collapse to
 *                           `{ owner: false, studentId: null }`
 *                           without echoing the device serial.
 *
 * Policy order (must match `design.md §6` and the lock-down matrix
 * in `test/unit/access-decision-service.test.ts`):
 *
 *   1. otp_proof missing / empty          → deny.otp_missing
 *   2. OTP {ok:false, reason:'invalid'}   → deny.otp_invalid
 *   3. OTP {ok:false, reason:'locked'}    → deny.lockout
 *   4. OTP {ok:false, reason:'unknown'}   → deny.dependency_fail
 *   5. OTP verify throws (5xx / timeout / unknown) → deny.dependency_fail
 *      The service MUST NEVER propagate the exception — the route
 *      always returns a clean DecisionResponse envelope.
 *   6. owner check returns {owner:false}  → deny.device_unknown
 *      Uniform across unknown / revoked / wrong-owner / inactive
 *      student. The serial is never echoed on any deny path.
 *   7. owner check returns {owner:true}   → { decision: 'allow',
 *                                             student_id, room_id?,
 *                                             media_policy? }
 *
 * Side contracts:
 *   - OTP verify is invoked with subject = String(input.canvas_user_id)
 *     and scope = ACCESS_DECISION_OTP_SCOPE = 'access.decision'.
 *   - The decision response NEVER contains the device serial on any
 *     deny path (no leak in deny message, no leak in audit).
 *   - No audit_log row is written by this service in B3.2. The OTP
 *     consumption itself is the attestation; full audit wiring is
 *     deferred to a subsequent unit. (Comment retained here so the
 *     intent survives the next round of editing.)
 */
import {
  ACCESS_DECISION_OTP_SCOPE,
  DecisionRequest,
  DecisionResponse,
} from '@quorum-backoffice/shared';
import type { VerifyOtpResult } from '@quorum-backoffice/shared';

/** Public surface of the owner-lookup dependency. */
export interface CheckOwnerFn {
  (serialNumber: string, canvasUserId: number): Promise<{ owner: boolean; studentId: number | null }>;
}

/** Minimal OtpClient surface used by this service. */
export interface OtpLike {
  verify(args: { subject: string; scope: string; code: string }): Promise<VerifyOtpResult>;
}

export interface AccessDecisionDeps {
  otp: OtpLike;
  checkOwner: CheckOwnerFn;
}

export interface AccessDecisionMeta {
  ip: string | null;
  userAgent: string | null;
}

export class AccessDecisionService {
  constructor(private readonly deps: AccessDecisionDeps) {}

  /**
   * Run the policy in the exact order documented at the top of this
   * file. The function is total — every dependency failure is mapped
   * to a deny code, never an exception.
   *
   * NOTE (B3.2): No audit row is written here. The OTP consumption
   * performed by `OtpClient.verify` is the attestation. Audit wiring
   * is deferred to a later unit so this service stays easy to mock
   * and the deny path cannot leak the serial through an audit row.
   */
  async decide(
    input: DecisionRequest,
    _meta: AccessDecisionMeta,
  ): Promise<DecisionResponse> {
    // (1) missing / empty otp_proof short-circuits before any
    // dependency call: probing the device table with a missing OTP
    // would leak ownership state, and probing the OTP service with
    // a missing code would burn a rate-limit window for nothing.
    if (!input.otp_proof || input.otp_proof.trim() === '') {
      return { decision: 'deny', student_id: null, denial: 'deny.otp_missing' };
    }

    // (2..5) OTP verification. Every failure mode — including a
    // thrown AppError or a bare throwable — collapses to a deny
    // envelope; the service MUST NEVER propagate.
    const subject = String(input.canvas_user_id);
    const scope = ACCESS_DECISION_OTP_SCOPE;
    const code = input.otp_proof;

    let otpResult: VerifyOtpResult;
    try {
      otpResult = await this.deps.otp.verify({ subject, scope, code });
    } catch {
      // Dependency outage, transport timeout, provider auth
      // failure, or any other thrown error → deny.dependency_fail.
      return { decision: 'deny', student_id: null, denial: 'deny.dependency_fail' };
    }

    if (!otpResult.ok) {
      if (otpResult.reason === 'invalid') {
        return { decision: 'deny', student_id: null, denial: 'deny.otp_invalid' };
      }
      if (otpResult.reason === 'locked') {
        return { decision: 'deny', student_id: null, denial: 'deny.lockout' };
      }
      // 'unknown' (and any other failure reason that OtpClient may
      // grow in the future) collapses to deny.dependency_fail so a
      // future OtpClient reason cannot accidentally leak through
      // the wire envelope.
      return { decision: 'deny', student_id: null, denial: 'deny.dependency_fail' };
    }

    // (6/7) Owner lookup. Uniform negative answer: the repository
    // never distinguishes unknown / revoked / wrong-owner / inactive
    // student, and this service does not second-guess it. The
    // device serial MUST NOT appear anywhere in the response — the
    // repository returns `studentId: null` (no serial) and we
    // mirror that here.
    const ownerCheck = await this.deps.checkOwner(input.device_id, input.canvas_user_id);
    if (!ownerCheck.owner || ownerCheck.studentId === null) {
      return { decision: 'deny', student_id: null, denial: 'deny.device_unknown' };
    }

    // Allow path. Mirror the optional room_id / media_policy
    // passthrough fields when the request supplied them — they are
    // omitted entirely (not echoed as undefined) when absent, so the
    // response shape stays minimal.
    const allow: DecisionResponse = {
      decision: 'allow',
      student_id: ownerCheck.studentId,
      denial: null,
    };
    if (input.room_id !== undefined) allow.room_id = input.room_id;
    if (input.media_policy !== undefined) allow.media_policy = input.media_policy;
    return allow;
  }
}