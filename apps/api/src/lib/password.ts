/**
 * bcrypt password hashing.
 *
 * Cost factor 12 — matches quorum-otp and the industry standard for
 * interactive logins in 2025. The constant is exported so the test suite
 * can use a lower cost (10) for speed; production stays at 12.
 */
import bcrypt from 'bcrypt';

export const BCRYPT_COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
