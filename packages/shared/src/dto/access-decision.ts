/**
 * Zod DTOs for the Canvas/Jitsi federated access feature.
 *
 * The BackOffice exposes a single
 * `POST /api/v1/access/decision` endpoint (B3.2) that other
 * services in the quorum ecosystem call to obtain an
 * allow/deny decision for a student trying to join a Jitsi
 * room from a specific device with a specific pre-issued OTP.
 *
 * Two callers are expected:
 *   - portal-api (Canvas pipeline) — calls the endpoint with
 *     a JWT-derived `idp_subject` plus a hardware-serial
 *     `device_id` and a per-session `otp_proof`.
 *   - jitsi-join (the join coordinator) — calls the endpoint
 *     with `room_id` / `media_policy` hints so the access
 *     decision can be propagated into the Jitsi room metadata.
 *
 * The denial taxonomy (`DenialCode`) is the single source of
 * truth for "why was this access denied" across the canvas +
 * jitsi surfaces. Every value in the enum must be a stable,
 * doc-blessed label so dashboards and incident response can
 * rely on the wire codes without consulting the source. Adding
 * a new value is a breaking change and must ship with a
 * companion migration to the corresponding Postgres enum.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// DenialCode (enum)
// ---------------------------------------------------------------------------
//
// The nine deny.* labels are the ONLY codes the access-decision
// endpoint emits. The list is locked by the B3.1 unit test
// `access-decision-schema.test.ts` which asserts the option list
// byte-for-byte against the design.md §6 taxonomy.
//
// Order matters: the option order is also the "documentation"
// order, so put the most common denials near the top.
export const DenialCode = z.enum([
  'deny.marbete_unknown',
  'deny.device_unknown',
  'deny.otp_missing',
  'deny.otp_invalid',
  'deny.lockout',
  'deny.enrollment_missing',
  'deny.media_denied',
  'deny.idp_untrusted',
  'deny.dependency_fail',
]);
export type DenialCode = z.infer<typeof DenialCode>;

// ---------------------------------------------------------------------------
// AccessDecision (literal union)
// ---------------------------------------------------------------------------
//
// `'allow' | 'deny'` is the top-level outcome. Kept as a literal
// union (not an enum) because the two values are part of the
// public wire contract and TS-only code can branch on them
// exhaustively.
export const AccessDecision = z.enum(['allow', 'deny']);
export type AccessDecision = z.infer<typeof AccessDecision>;

// ---------------------------------------------------------------------------
// ACCESS_DECISION_OTP_SCOPE
// ---------------------------------------------------------------------------
//
// The scope the access-decision endpoint verifies OTPs against in the
// quorum-otp service. Exported as a constant (not derived from a
// runtime config) because the value is part of the wire contract with
// the OTPs issued out-of-band: any change here requires a coordinated
// re-issuance of in-flight codes. Keep it short (<=64 chars per the
// OtpClient scope envelope).
export const ACCESS_DECISION_OTP_SCOPE = 'access.decision';

// ---------------------------------------------------------------------------
// DecisionRequest
// ---------------------------------------------------------------------------
//
// The current decision path needs exactly three things:
//   1. The device the user is calling from (`device_id`) — the
//      pairing record in the `dispositivos` table is the
//      authority on whether the hardware is registered.
//   2. A pre-issued OTP (`otp_proof`) — the user has either
//      pasted this in from a sister system or has it on a
//      secondary device. We verify it against quorum-otp with
//      scope ACCESS_DECISION_OTP_SCOPE and subject =
//      String(canvas_user_id). Empty / whitespace-only values are
//      accepted by the schema and surface as `deny.otp_missing` so
//      a malformed caller gets a stable deny code rather than a
//      400 validation error.
//   3. The interim identity (`canvas_user_id`) — the B3.2 wire
//      contract resolves ownership against `canvas_user_id`
//      because the IdP→internal-id mapping is not yet wired.
//      This field is REQUIRED; once the IdP mapping exists it
//      will be replaced by a derived identity and `idp_subject`
//      will carry the upstream token.
//
// Everything else is optional context the decision logic may
// pick up if present:
//   - `idp_subject`  — the canonical identity from the IdP
//                      (e.g. `canvas:42`). Reserved for the
//                      future IdP mapping; currently optional
//                      and ignored by the decision policy.
//   - `marbete_id`   — the marbete (physical security tag)
//                      associated with the device, when known.
//   - `room_id`      — the Jitsi room the user is trying to
//                      join. Used to apply room-level policy.
//   - `media_policy` — the requested media posture
//                      (`allow_mic_only`, `allow_mic_camera`,
//                      etc.). Used to apply policy decisions.
export const DecisionRequest = z.object({
  idp_subject: z.string().min(1).max(256).optional(),
  marbete_id: z.string().min(1).max(64).optional(),
  device_id: z.string().min(1).max(128),
  // Empty / whitespace-only are accepted at the wire boundary so the
  // service can map them to `deny.otp_missing`; the OTP client
  // layer enforces the actual non-empty content.
  otp_proof: z.string().max(64),
  canvas_user_id: z.number().int().positive(),
  room_id: z.string().min(1).max(128).optional(),
  media_policy: z.string().min(1).max(64).optional(),
});
export type DecisionRequest = z.infer<typeof DecisionRequest>;

// ---------------------------------------------------------------------------
// DecisionResponse
// ---------------------------------------------------------------------------
//
// The response always carries:
//   - `decision`   — `'allow'` or `'deny'`
//   - `student_id` — the resolved student id when known; `null`
//                    if unknown or the request was denied
//   - `denial`     — the DenialCode when `decision === 'deny'`,
//                    `null` when `decision === 'allow'`
//
// It also mirrors back the optional `room_id` and `media_policy`
// passthrough fields when the request supplied them, so the
// caller can correlate the response with the request without
// re-asserting context. These fields are present in the response
// shape ONLY when they were present in the request — they are
// not echoed with empty strings.
export const DecisionResponse = z.object({
  decision: AccessDecision,
  student_id: z.number().int().positive().nullable(),
  denial: DenialCode.nullable(),
  room_id: z.string().min(1).max(128).optional(),
  media_policy: z.string().min(1).max(64).optional(),
});
export type DecisionResponse = z.infer<typeof DecisionResponse>;
