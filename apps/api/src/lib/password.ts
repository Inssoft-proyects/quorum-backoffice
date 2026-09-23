/**
 * Password hashing.
 *
 * Two algorithms coexist:
 *   - argon2id (current default for new users; OWASP 2025+ recommendation)
 *   - bcrypt cost 12 (legacy; only used to verify hashes created before
 *     the migration). Existing users with bcrypt hashes are transparently
 *     upgraded to argon2id on their next successful login.
 *
 * Hash format is auto-detected by PHC string prefix:
 *   - $argon2id$...  →  argon2id (verified by the @node-rs/argon2 library,
 *                        algorithm-pinned so an attacker cannot downgrade)
 *   - $2[aby]$...    →  bcrypt cost 12
 *
 * Both verifiers run in the same `verifyPassword` function so call sites do
 * not need to know the storage format. New users always get argon2id.
 *
 * argon2id parameters (OWASP 2025+ minimum for interactive logins):
 *   memory cost = 65536 KiB (64 MiB)
 *   time cost   = 3
 *   parallelism = 4
 *
 * bcrypt cost is kept at 12 for backward-compat verification only.
 */
import bcrypt from 'bcrypt';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

export const BCRYPT_COST = 12;

/**
 * Numeric ID of the argon2id algorithm in @node-rs/argon2.
 *
 * The upstream `Algorithm.Argon2id = 2` is declared as a `const enum` in
 * the package's `.d.ts`. We can't import it as a value because the
 * workspace tsconfig enables `isolatedModules`. The value is stable
 * across all published versions of @node-rs/argon2 (2.2.x) and matches
 * the IANA argon2 specification for argon2id.
 */
const ARGON2ID_ALGORITHM_ID = 2;

/** argon2id PHC parameters used for both hashing and verification. */
export const ARGON2ID_OPTIONS = {
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
  algorithm: ARGON2ID_ALGORITHM_ID,
} as const;

/** Hash a fresh password with argon2id. Used for all new users. */
export async function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON2ID_OPTIONS);
}

/**
 * Verify a password against a stored hash. Auto-dispatches to the right
 * algorithm based on the PHC string prefix. Returns false on any failure
 * (including malformed hashes) — does NOT throw, so call sites can use it
 * as a simple boolean.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (hash.startsWith('$argon2id$')) {
    try {
      // Algorithm-pinned: even if the stored PHC string claimed a weaker
      // algorithm, verify compares against argon2id.
      return await argonVerify(hash, plain, { algorithm: ARGON2ID_ALGORITHM_ID });
    } catch {
      return false;
    }
  }
  if (hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$')) {
    try {
      return await bcrypt.compare(plain, hash);
    } catch {
      return false;
    }
  }
  // Unknown hash format: fail closed. This should never happen with data
  // written by our own code; if it does, log and reject.
  return false;
}

/** True if the hash is a bcrypt legacy hash that should be upgraded on next login. */
export function isLegacyBcryptHash(hash: string): boolean {
  return hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$');
}
