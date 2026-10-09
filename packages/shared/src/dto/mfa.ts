/**
 * Zod DTOs for the MFA authentication surface (M1 / Canvas-Jitsi
 * federated access).
 *
 * The BackOffice exposes a single
 * `POST /api/v1/mfa/authenticate` endpoint that authenticates a
 * student with three factors:
 *
 *   1. **Marbete code** — physical security token bound to a student
 *      via `marbetes.assigned_student_id`.
 *   2. **Device serial** — the device the student is using, bound to
 *      the same student via `dispositivos.assigned_student_id`.
 *   3. **Dynamic OTP** — a pre-issued code from the operator
 *      (the `POST /v1/operator/otps` flow in `quorum-otp`), scoped
 *      to `mfa.access` under the F4 allow-list.
 *
 * The MFA response is its own shape (NOT a `DecisionResponse`
 * envelope) because:
 *
 *   - a successful authentication issues a session cookie AND
 *     returns the resolved student identity in one step, while
 *     the access-decision endpoint is a stateless allow/deny
 *     policy lookup;
 *   - the MFA denial taxonomy is a small superset of the
 *     `access-decision` deny.* codes (it adds
 *     `deny.student_inactive` and `deny.device_not_bound_to_student`
 *     because the MFA flow binds the marbete → device → student
 *     chain in a single transaction and surfaces each step of
 *     the chain as a distinct denial reason).
 *
 * The shared denial taxonomy is the single source of truth for
 * "why was this access denied" across the canvas + jitsi
 * surfaces. The MFA-specific codes live in the same
 * `DenialCode` enum in `access-decision.ts` so dashboards and
 * incident response can rely on the wire codes without consulting
 * the source. Adding a new value is a breaking change and must
 * ship with a companion migration.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// MFA_AUTHENTICATE_OTP_SCOPE
// ---------------------------------------------------------------------------
//
// The scope the MFA endpoint verifies OTPs against in the quorum-otp
// service. Exported as a constant (not derived from a runtime config)
// because the value is part of the wire contract with the OTPs issued
// out-of-band: any change here requires a coordinated re-issuance of
// in-flight codes. Keep it short (<=64 chars per the OtpClient scope
// envelope) and stable.
//
// The scope is a single literal 'mfa.access' (matches the M0 plan:
// "Document the new scope in docs/SECURITY.md with the rationale
// (marbete + device + OTP MFA flow)").
export const MFA_AUTHENTICATE_OTP_SCOPE = 'mfa.access';

// ---------------------------------------------------------------------------
// MFA_SESSION_COOKIE_NAME
// ---------------------------------------------------------------------------
//
// Cookie name for the student session. The leading `__Host-` prefix
// is mandated by the route layer (it forces Secure + Path=/ + no
// Domain attribute), but the prefix is documented here so a refactor
// of `app.ts` or a future cookie-rotation can find the contract at
// the DTO layer.
export const MFA_SESSION_COOKIE_NAME = '__Host-mfa_sid';

// ---------------------------------------------------------------------------
// MfaAuthenticateRequest
// ---------------------------------------------------------------------------
//
// The three factors the student submits. The marbete code is the raw
// physical-code value (the API hashes it with sha256 at request time
// and compares to `marbetes.code_hash` — the raw value is never
// logged). The serial is the device's printed identifier (the
// canonical UNIQUE column on the dispositivos table). The OTP is the
// 6-character uppercase alphanumeric code the operator hands out.
//
// Field bounds:
//   - marbete_code: 8..128 chars, matches the marbete table CHECK
//                   constraint on `code_hash` and the existing
//                   `CreateMarbeteRequest.code` envelope. An empty
//                   value is rejected at the wire boundary with a
//                   400 `validation_error` so the operator can
//                   distinguish "client bug" from "deny.marbete_unknown".
//   - serial_number: 3..128 chars, matches the dispositivos.serial_number
//                    column bounds. Same rationale as the marbete
//                    code: an empty / missing serial is a 400.
//   - otp: exactly 6 chars, uppercase alphanumeric. Same as the
//          existing `OtpToken` envelope so the user-visible error
//          messages are identical across login + MFA.
export const MfaAuthenticateRequest = z.object({
  marbete_code: z
    .string()
    .min(8, 'marbete_code must be at least 8 chars')
    .max(128, 'marbete_code must be at most 128 chars'),
  serial_number: z
    .string()
    .min(3, 'serial_number must be at least 3 chars')
    .max(128, 'serial_number must be at most 128 chars'),
  otp: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(
      z
        .string()
        .length(6, 'otp must be 6 chars')
        .regex(/^[A-Z0-9]+$/, 'otp must be uppercase alphanumeric'),
    ),
});
export type MfaAuthenticateRequest = z.infer<typeof MfaAuthenticateRequest>;

// ---------------------------------------------------------------------------
// MfaAuthenticateResponse
// ---------------------------------------------------------------------------
//
// The success envelope returned to the client. The session cookie is
// set as a side effect (the `__Host-mfa_sid` Set-Cookie header is
// written by the route layer, NOT echoed in the body).
//
//   - canvas_user_id : the Canvas LMS user id (the subject the
//                      session is keyed by; the route's
//                      requireSession equivalent resolves it from
//                      the cookie on subsequent calls).
//   - student_name   : denormalized for the first response so the
//                      client can render the success screen without
//                      a follow-up `GET /api/v1/mfa/session` call.
//   - student_email  : same rationale as student_name.
//   - role           : always 'student' for the MFA session (the
//                      other 'user' role is reserved for BackOffice
//                      operator sessions).
//   - session_id     : the opaque session token (same value as the
//                      cookie; surfaced in the body so the JSON
//                      channel — M5 — can use it without a cookie
//                      store).
//   - expires_at     : ISO 8601 timestamp of the session expiry.
export const MfaAuthenticateResponse = z.object({
  canvas_user_id: z.number().int().positive(),
  student_name: z.string().min(1),
  student_email: z.string().email(),
  role: z.literal('student'),
  session_id: z.string().min(16).max(128),
  expires_at: z.string().datetime(),
});
export type MfaAuthenticateResponse = z.infer<typeof MfaAuthenticateResponse>;

// ---------------------------------------------------------------------------
// MfaSessionResponse
// ---------------------------------------------------------------------------
//
// The response of `GET /api/v1/mfa/session` (the small bonus route
// that mirrors `GET /api/v1/operator/sessions/current` for the
// MFA student session). Returns `null` for the student fields when
// no MFA session is active so a logged-out client gets a stable
// shape it can branch on. The route returns 401 (not the
// `MfaSessionResponse` shape) when the session is unknown, so a
// 200 response here ALWAYS corresponds to a `kind='student'`
// session — the `role` is therefore implied (always 'student')
// and not echoed on the wire.
export const MfaSessionResponse = z.object({
  canvas_user_id: z.number().int().positive().nullable(),
  student_name: z.string().nullable(),
  student_email: z.string().email().nullable(),
  session_id: z.string().min(16).max(128).nullable(),
  expires_at: z.string().datetime().nullable(),
});
export type MfaSessionResponse = z.infer<typeof MfaSessionResponse>;
