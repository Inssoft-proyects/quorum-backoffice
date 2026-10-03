/**
 * Shared grant-aware OTP verification helper.
 *
 * Extracted in WU G3/F3 of `odd/tasks/marbetes-v3-asignacion.md` §10 to
 * remove the duplication between `MarbetesService.verifyOtp` and
 * `MatriculasService.verifyOtpGrant`. The semantics implemented here
 * are exactly the union of today's two copies — no caller-visible
 * change.
 *
 * Behaviour matrix (mirrors the two pre-extraction copies):
 *
 *   - `grantEligible = false` (reveal-style):
 *       ALWAYS call the provider. No grant lookup, no grant create.
 *       The caller is opting out of the 20-minute window for a
 *       specific action (today: `marbete.reveal`).
 *
 *   - `grantEligible = true` + active grant for `(actor, grantScope)`:
 *       log debug `otp_grant_hit`, return
 *       `{ otpId: <grant.otp_id> }` without calling the provider.
 *
 *   - `grantEligible = true` + no grant + no `otpCode`:
 *       throw `otp_required` (401) with the caller-supplied message.
 *
 *   - `grantEligible = true` + no grant + `otpCode`:
 *       verify via `OtpClient`. On success, best-effort INSERT into
 *       `otp_grants` (a failure to insert logs warn
 *       `otp_grant_insert_failed` and does NOT undo the already-
 *       verified destructive op). On provider rejection, log warn
 *       `otp_verify_failed` and throw `otp_invalid` (401).
 *
 * All log event names (`otp_grant_hit`, `otp_grant_insert_failed`,
 * `otp_verify_failed`) and error codes (`otp_required`, `otp_invalid`)
 * match the pre-extraction copies byte-for-byte.
 */
import type { FastifyBaseLogger } from 'fastify';
import { OtpClient } from '../services/otp-client';
import { OtpGrantService } from '../services/otp-grant-service';
import { AppError } from './errors';

export interface OtpVerifyDeps {
  /** OTP provider client (quorum-otp). */
  otp: OtpClient;
  /**
   * Optional grant cache. When `null` / `undefined`, the helper behaves
   * as if no grant existed for every call (graceful degradation for
   * unit-test wiring without `OtpGrantService`).
   */
  grant?: OtpGrantService | null;
  /** Structured logger — receives the same three log event names as
   *  before extraction. */
  log: FastifyBaseLogger;
}

export interface OtpVerifyInput {
  /** Actor username (audit_id). */
  actor: string;
  /** Audit-action label; also forwarded to the provider as the OTP scope. */
  action: string;
  /** The 6-char OTP the caller received on the wire. May be undefined
   *  when a grant covers the scope. */
  otpCode: string | undefined;
  /** Whether this action consults the grant cache. `marbete.reveal`
   *  passes false; `marbete.create` / `marbete.update` /
   *  `marbete.delete` / `marbete.bulk_create` pass true.
   *  `MatriculasService` passes true for its grant-eligible scope
   *  (`marbete.update`). */
  grantEligible: boolean;
  /** The `otp_grants.scope` value this helper looks up — `marbete`
   *  today. */
  grantScope: string;
  /** Override for the `otp_required` error message. Defaults to the
   *  generic destructive-ops message used by `MarbetesService`.
   *  `MatriculasService` passes its own copy to keep the API
   *  envelope byte-identical for clients. */
  otpRequiredMessage?: string;
}

/**
 * Per-operation OTP verify (no grant cache consultation). Internal —
 * not exported. Throws `AppError` on failure; returns `{ otpId }` on
 * success. The provider-failure path logs `otp_verify_failed` warn.
 *
 * Hard-coded fallback for the `otp_required` message matches the
 * `MarbetesService` copy pre-extraction byte-for-byte.
 */
async function verifyFreshOtp(
  deps: OtpVerifyDeps,
  input: OtpVerifyInput,
): Promise<{ otpId: string }> {
  if (!input.otpCode) {
    const fallback =
      'X-OTP-Code header missing; destructive operations require a single-use 6-char OTP.';
    throw new AppError(
      'otp_required',
      input.otpRequiredMessage ?? fallback,
      401,
      { action: input.action },
    );
  }
  const r = await deps.otp.verify({
    subject: input.actor,
    scope: input.action,
    code: input.otpCode,
  });
  if (!r.ok) {
    deps.log.warn(
      { actor: input.actor, action: input.action, reason: r.reason },
      'otp_verify_failed',
    );
    throw new AppError(
      'otp_invalid',
      `otp verify rejected: ${r.reason}`,
      401,
      { action: input.action, reason: r.reason },
    );
  }
  return { otpId: r.otpId };
}

/**
 * Verify a destructive-action OTP with grant-aware short-circuiting.
 * See the module header for the full behaviour matrix.
 *
 * This is the shared entry point for `MarbetesService.verifyOtp` and
 * `MatriculasService.verifyOtpGrant`; the per-caller `noop` /
 * destructive-set check stays in the caller's private wrapper so the
 * helper is single-purpose.
 */
export async function verifyOtpWithGrant(
  deps: OtpVerifyDeps,
  input: OtpVerifyInput,
): Promise<{ otpId: string }> {
  // Reveal-style: always per-op OTP, never consult the grant cache.
  if (!input.grantEligible) {
    return verifyFreshOtp(deps, input);
  }

  // Grant-eligible: try the cache first.
  if (deps.grant) {
    const existing = await deps.grant.findActive(input.actor, input.grantScope);
    if (existing) {
      deps.log.debug(
        { actor: input.actor, action: input.action, grantId: existing.id },
        'otp_grant_hit',
      );
      return { otpId: existing.otp_id };
    }
  }

  // Grant-miss: require a fresh OTP, verify, then mint a grant so
  // subsequent destructive ops within the window skip the per-op
  // OTP. The destructive op MUST NOT be undone if the grant insert
  // fails — see the warn-logged catch.
  const verified = await verifyFreshOtp(deps, input);

  if (deps.grant && verified.otpId !== 'noop') {
    try {
      await deps.grant.create(input.actor, input.grantScope, verified.otpId);
    } catch (err) {
      deps.log.warn(
        {
          actor: input.actor,
          action: input.action,
          otpId: verified.otpId,
          err: (err as Error).message,
        },
        'otp_grant_insert_failed',
      );
    }
  }

  return verified;
}