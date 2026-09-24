/**
 * Zod DTOs + role hierarchy for the backoffice auth surface.
 *
 * Roles are ordered by privilege: operator < auditor < admin. The `auditor`
 * role can read everything (marbetes, dispositivos, audit) but cannot write.
 * `admin` can do everything. `operator` can read and perform limited writes.
 *
 * Polish WU v6: the login flow moves from `email + password` to
 * `email + OTP`. The two-step flow is exposed as:
 *   - POST /api/v1/auth/login/request  → `RequestLoginRequest` (email only)
 *   - POST /api/v1/auth/login         → `LoginRequestOtp` (email + otp code)
 * `password` is kept in `LoginRequest` for backwards compatibility with
 * older clients and the seed test suite; the backend ignores it.
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
 * Request an OTP be sent to the user's email so they can complete
 * login. The endpoint is intentionally idempotent-looking: it returns
 * 200 even when the email is unknown, to avoid leaking which
 * addresses have accounts (audit is still emitted with the
 * actor email so we can detect brute-force sweeps).
 */
export const RequestLoginRequest = z.object({
  email: z.string().email().max(254),
});
export type RequestLoginRequest = z.infer<typeof RequestLoginRequest>;

export interface RequestLoginResponse {
  ok: true;
  /** Seconds the user should wait before requesting another OTP. */
  retryAfterSeconds: number;
}

/**
 * Exchange an email + 6-digit OTP for a session cookie. `password` is
 * accepted but ignored; it exists for backwards compatibility with
 * older clients and the legacy seed test. The backend always verifies
 * the OTP, never the password.
 */
export const LoginRequestOtp = z.object({
  email: z.string().email().max(254),
  otp: z.string().regex(/^[A-Z0-9]{6}$/, 'otp must be 6 alphanumeric chars').max(6),
  /** @deprecated kept for legacy clients; ignored by the backend. */
  password: z.string().min(1).max(256).optional(),
});
export type LoginRequestOtp = z.infer<typeof LoginRequestOtp>;

/**
 * Legacy alias kept so existing test fixtures and old clients still
 * type-check. New code MUST use {@link LoginRequestOtp}.
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
