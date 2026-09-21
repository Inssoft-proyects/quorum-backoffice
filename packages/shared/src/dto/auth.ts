/**
 * Zod DTOs + role hierarchy for the backoffice auth surface.
 *
 * Roles are ordered by privilege: operator < auditor < admin. The `auditor`
 * role can read everything (marbetes, dispositivos, audit) but cannot write.
 * `admin` can do everything. `operator` can read and perform limited writes.
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

export const LoginRequest = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

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
