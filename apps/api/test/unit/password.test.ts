/**
 * Unit tests for the dual-format password hashing module.
 *
 * Covers the WU5 migration from bcrypt to argon2id:
 *   - hashPassword() emits an argon2id PHC string
 *   - verifyPassword() round-trips a fresh argon2id hash
 *   - verifyPassword() rejects wrong passwords
 *   - verifyPassword() verifies legacy bcrypt hashes (backward compat)
 *   - verifyPassword() fails closed on unknown / garbage hash formats
 *   - isLegacyBcryptHash() classifies the bcrypt prefixes and rejects argon2id
 *
 * Match style of `apps/api/test/unit/smoke.test.ts` (jest globals, no extra
 * deps). bcrypt is already a runtime dependency so we can import it directly
 * for the legacy-hash verification test.
 */
import bcrypt from 'bcrypt';
import {
  ARGON2ID_OPTIONS,
  BCRYPT_COST,
  hashPassword,
  isLegacyBcryptHash,
  verifyPassword,
} from '../../src/lib/password';

describe('password module (argon2id + bcrypt dual verifier)', () => {
  describe('hashPassword', () => {
    it('returns an argon2id PHC string with parameters embedded', async () => {
      const hash = await hashPassword('Sup3r$ecret');
      expect(typeof hash).toBe('string');
      expect(hash.startsWith('$argon2id$')).toBe(true);
      // PHC parameters must be present so verify() can reconstruct them.
      expect(hash).toContain(`m=${ARGON2ID_OPTIONS.memoryCost}`);
      expect(hash).toContain(`t=${ARGON2ID_OPTIONS.timeCost}`);
      expect(hash).toContain(`p=${ARGON2ID_OPTIONS.parallelism}`);
    });
  });

  describe('verifyPassword (argon2id round-trip)', () => {
    it('returns true for the correct password', async () => {
      const plain = 'r0und-tr1p-pass!';
      const hash = await hashPassword(plain);
      await expect(verifyPassword(plain, hash)).resolves.toBe(true);
    });

    it('returns false for a different password', async () => {
      const hash = await hashPassword('correct-horse');
      await expect(verifyPassword('wrong-battery', hash)).resolves.toBe(false);
    });

    it('returns false for an unknown hash format (fail closed)', async () => {
      await expect(verifyPassword('whatever', '$garbage$not-a-real-hash')).resolves.toBe(false);
    });
  });

  describe('verifyPassword (legacy bcrypt backward-compat)', () => {
    it('verifies a hash produced by bcrypt.hash(plain, 12)', async () => {
      const plain = 'legacy-bcrypt-pass';
      const legacyHash = await bcrypt.hash(plain, BCRYPT_COST);
      expect(legacyHash.startsWith('$2')).toBe(true);
      await expect(verifyPassword(plain, legacyHash)).resolves.toBe(true);
      await expect(verifyPassword('wrong', legacyHash)).resolves.toBe(false);
    });

    it('dispatches to argon2id for argon2id hashes (does not fall through to bcrypt)', async () => {
      // An argon2id hash passed through bcrypt.compare would throw; verify
      // must take the argon2id branch.
      const hash = await hashPassword('argon-only');
      await expect(verifyPassword('argon-only', hash)).resolves.toBe(true);
      await expect(verifyPassword('nope', hash)).resolves.toBe(false);
    });
  });

  describe('isLegacyBcryptHash', () => {
    it('returns true for $2a$', () => {
      expect(isLegacyBcryptHash('$2a$12$abcdefghijklmnopqrstuvwxyz')).toBe(true);
    });
    it('returns true for $2b$', () => {
      expect(isLegacyBcryptHash('$2b$12$abcdefghijklmnopqrstuvwxyz')).toBe(true);
    });
    it('returns true for $2y$', () => {
      expect(isLegacyBcryptHash('$2y$12$abcdefghijklmnopqrstuvwxyz')).toBe(true);
    });
    it('returns false for an argon2id hash', async () => {
      const hash = await hashPassword('whatever');
      expect(isLegacyBcryptHash(hash)).toBe(false);
    });
    it('returns false for an unknown prefix', () => {
      expect(isLegacyBcryptHash('$argon2i$...')).toBe(false);
      expect(isLegacyBcryptHash('$garbage$...')).toBe(false);
    });
  });
});
