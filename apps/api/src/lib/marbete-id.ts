/**
 * Helpers for marbete identity + masking.
 *
 *   - generatePublicUid(): operator-friendly id ("m-AB12CD")
 *   - sha256Hex():          sha256 of a code, used to populate code_hash
 *   - maskCode():           display-only mask ("3***24")
 *
 * Pure functions; safe to unit-test.
 */
import { createHash, randomBytes } from 'node:crypto';

const PUBLIC_UID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // confusable-free, 31 chars

export function generatePublicUid(): string {
  const bytes = randomBytes(4); // 4 bytes -> 5 base32 chars
  let out = 'm-';
  for (let i = 0; i < 4; i++) {
    const b = bytes[i] ?? 0;
    out += PUBLIC_UID_ALPHABET[b % PUBLIC_UID_ALPHABET.length];
  }
  return out;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Display mask: first 1 char + *** + last 2 chars. Falls back to *** for
 * codes shorter than 4 chars (defensive).
 */
export function maskCode(code: string): string {
  if (code.length <= 3) return '***';
  return `${code[0]}***${code.slice(-2)}`;
}
