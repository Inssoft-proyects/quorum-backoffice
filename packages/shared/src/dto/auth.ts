/**
 * Zod DTOs + role hierarchy for the backoffice auth surface.
 *
 * Roles are ordered by privilege: operator < auditor < admin. The `auditor`
 * role can read everything (marbetes, dispositivos, audit) but cannot write.
 * `admin` can do everything. `operator` can read and perform limited writes.
 *
 * Login surface (single-step username + pre-issued OTP):
 *   - POST /api/v1/auth/login   → `LoginRequestOtp` ({ username, otp })
 *
 * The BackOffice no longer accepts `email + password`, does not request
 * an OTP, and does not deliver one — OTPs are issued out-of-band by the
 * broader quorum ecosystem and arrive at the user pre-typed. The provider
 * contract binds the OTP to (canonical username, scope='login') and is
 * HMAC-signed under the service identity `quorum-backoffice`.
 */
import { z } from 'zod';

export const UserRole = z.enum(['admin', 'operator', 'auditor']);
export type UserRole = z.infer<typeof UserRole>;

export const ROLE_HIERARCHY: Record<UserRole, number> = {
  operator: 1,
  auditor: 2,
  admin: 3,
};

export function hasAtLeastRole(actual: UserRole, min: UserRole): boolean {
  return ROLE_HIERARCHY[actual] >= ROLE_HIERARCHY[min];
}

/**
 * Validate a BackOffice username at the wire boundary. The repository
 * applies the same canonicalisation (trim + lowercase) on lookup. The
 * server is the only authority on uniqueness — the client should not
 * normalize in user-visible copy.
 */
export const Username = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9._-]+$/, 'username must be 3-32 chars, alnum + . _ -');
export type Username = z.infer<typeof Username>;

/**
 * 6-character uppercase alphanumeric OTP. The OTP service issues codes
 * in this alphabet (digits + uppercase letters). The client upper-cases
 * typed input to match the wire contract without changing semantics.
 */
export const OtpToken = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(
    z
      .string()
      .length(6, 'otp must be 6 chars')
      .regex(/^[A-Z0-9]+$/, 'otp must be uppercase alphanumeric'),
  );
export type OtpToken = z.infer<typeof OtpToken>;

/**
 * Single-step login payload. The legacy `email` and `password` fields
 * were removed: BackOffice no longer accepts those paths.
 */
export const LoginRequestOtp = z.object({
  username: Username,
  otp: OtpToken,
});
export type LoginRequestOtp = z.infer<typeof LoginRequestOtp>;

/**
 * Legacy alias kept so existing test fixtures and old clients still
 * type-check during the migration. New code MUST use {@link LoginRequestOtp}.
 * Note: the shape changed from `{ email, otp }` to `{ username, otp }` —
 * existing tests are updated as part of this change.
 */
export const LoginRequest = LoginRequestOtp;
export type LoginRequest = LoginRequestOtp;

export interface MeResponse {
  id: number;
  email: string;
  role: UserRole;
}

export interface LoginResponse {
  user: MeResponse;
}

export const LogoutResponse = z.object({
  ok: z.literal(true),
});
export type LogoutResponse = z.infer<typeof LogoutResponse>;
