/**
 * Session token generator.
 *
 * 32 random bytes encoded as base64url (~43 chars). The token is the
 * primary key of the `sessions` table; the cookie carries it as-is.
 * No PII, no structural info — just an opaque identifier.
 */
import { randomBytes } from 'node:crypto';

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Validate that a string looks like one of our tokens (defends against
 * accidentally passing arbitrary user input into a DB lookup).
 */
export function isValidSessionToken(value: string | undefined | null): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}
