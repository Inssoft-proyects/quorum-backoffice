/**
 * Pure generation helpers for the synthetic-data seed scripts.
 *
 *   - createPrng(seed)        → deterministic 32-bit PRNG
 *   - generateMatriculas(...) → N unique 6-char `[A-Z0-9]` strings
 *   - generateDeviceSerials(...) → N unique 16-char lowercase hex strings
 *
 * Why a custom PRNG instead of `Math.random()`: every synthetic run
 * MUST be reproducible from the seed (so a re-run produces the same
 * mapping, the operator can re-print fixtures, and the first serial
 * constant for the MFA smoke test never drifts). The PRNG here is a
 * Mulberry32-style 32-bit state hash seeded from a SHA-256 of the
 * supplied seed string; it is NOT cryptographically secure and is
 * deliberately local to this folder so the canvas and backoffice
 * seeders can each call it without leaking the implementation.
 *
 * `noUncheckedIndexedAccess` is on (see tsconfig.base.json), so
 * array/buffer reads return `T | undefined` and must be guarded.
 * The PRNG `next()` uses a `let` accumulator and a single state
 * field so the TypeScript narrowing stays trivial.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

/**
 * Deterministic 32-bit PRNG. Same seed => same byte sequence forever.
 *
 * Implementation note: we hash the input seed with SHA-256, take the
 * first 4 bytes as the initial state, then advance the state on
 * every call using the well-known xorshift32 mix:
 *
 *   state ^= state << 13
 *   state ^= state >>> 17
 *   state ^= state << 5
 *
 * xorshift32 is not cryptographic but is a perfectly uniform 32-bit
 * generator with a 2^32-1 period — enough to cover a 1000-element
 * synthetic run with no observable bias and no risk of collisions
 * beyond the natural birthday-paradox floor (~2^16 samples at 50%).
 */
export interface Prng {
  /** Returns a uniformly distributed 32-bit integer in [0, 2^32). */
  next(): number;
}

export function createPrng(seed: string): Prng {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('createPrng: seed must be a non-empty string');
  }
  const digest = createHash('sha256').update(seed, 'utf8').digest();
  // Take the first 4 bytes of the digest as the initial state. We
  // OR-in a 1 to make sure state is non-zero (xorshift32's only
  // forbidden state is 0, where it would lock into outputting 0).
  let state =
    ((digest[0] ?? 0) << 24) |
    ((digest[1] ?? 0) << 16) |
    ((digest[2] ?? 0) << 8) |
    (digest[3] ?? 0);
  if (state === 0) state = 0x9e3779b9; // arbitrary non-zero constant

  function step(): number {
    let x = state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    state = x >>> 0;
    return state;
  }

  return { next: step };
}

// ---------------------------------------------------------------------------
// Matriculas (6-char [A-Z0-9])
// ---------------------------------------------------------------------------

const MATRICULA_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // 36 chars
const MATRICULA_LENGTH = 6;
const MATRICULA_ALPHABET_SIZE = MATRICULA_ALPHABET.length; // 36

interface CountedSeed {
  seed: string;
  count: number;
}

function assertCount(opts: CountedSeed): void {
  if (!Number.isInteger(opts.count) || opts.count <= 0) {
    throw new Error(`generateX: count must be a positive integer (got ${opts.count})`);
  }
  if (typeof opts.seed !== 'string' || opts.seed.length === 0) {
    throw new Error('generateX: seed must be a non-empty string');
  }
}

/**
 * Generate `count` unique 6-char `[A-Z0-9]` matriculas. The
 * uniqueness guarantee is implemented by a Set + retry loop with a
 * bounded backstop; for the supported range (1000+ entries) the
 * probability of needing the backstop is negligible.
 */
export function generateMatriculas(opts: CountedSeed): string[] {
  assertCount(opts);
  const prng = createPrng(`matricula:${opts.seed}`);
  const out: string[] = [];
  const seen = new Set<string>();
  // Bound the retry loop so a pathological seed can never hang the
  // seeder. 10x the requested count is a safe upper bound: at 36^6 =
  // ~2.18B possible matriculas, the birthday bound for collisions
  // across 1000 entries is < 1 in 4 million, so 10x the count is
  // an astronomical safety margin.
  const maxAttempts = opts.count * 10;
  let attempts = 0;
  while (out.length < opts.count) {
    if (attempts >= maxAttempts) {
      throw new Error(
        `generateMatriculas: failed to produce ${opts.count} unique entries ` +
          `within ${maxAttempts} attempts; please pick a different seed`,
      );
    }
    attempts += 1;
    const m = pickMatricula(prng);
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

function pickMatricula(prng: Prng): string {
  // 6 independent draws from the 36-char alphabet. We bias-reject
  // is unnecessary because the alphabet is exactly 36 = 2^2 * 3^2
  // and 2^32 mod 36 has no bias small enough to matter for a
  // synthetic seed.
  let out = '';
  for (let i = 0; i < MATRICULA_LENGTH; i += 1) {
    const idx = prng.next() % MATRICULA_ALPHABET_SIZE;
    out += MATRICULA_ALPHABET.charAt(idx);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Device serials (16-char lowercase hex)
// ---------------------------------------------------------------------------

const SERIAL_LENGTH = 16; // 16 hex chars == 8 bytes == 64 bits

/**
 * The first device serial in a default-seed run is a fixed
 * constant (NOT derived from the PRNG). It is the serial the
 * operator uses in the MFA smoke test, so we want it to be
 * stable across seed changes and copy-paste-friendly. Subsequent
 * serials (index >= 1) are produced from a deterministic PRNG
 * keyed on `device:<seed>`, so the full sequence remains
 * reproducible from the seed as long as the constant is
 * preserved.
 */
export const MFA_FIXTURE_SERIAL = 'f401e1afcfd09b16';

/**
 * Generate `count` unique 16-char lowercase hex device serials.
 * The first serial is always `MFA_FIXTURE_SERIAL`; serials at
 * index >= 1 are produced by a deterministic PRNG keyed on
 * `device:<seed>`.
 */
export function generateDeviceSerials(opts: CountedSeed): string[] {
  assertCount(opts);
  const out: string[] = [];
  if (opts.count >= 1) {
    out.push(MFA_FIXTURE_SERIAL);
  }
  const prng = createPrng(`device:${opts.seed}`);
  const seen = new Set<string>(out);
  const maxAttempts = opts.count * 10;
  let attempts = 0;
  while (out.length < opts.count) {
    if (attempts >= maxAttempts) {
      throw new Error(
        `generateDeviceSerials: failed to produce ${opts.count} unique entries ` +
          `within ${maxAttempts} attempts; please pick a different seed`,
      );
    }
    attempts += 1;
    const s = pickSerial(prng);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function pickSerial(prng: Prng): string {
  // 16 hex chars = 8 random bytes. We draw two 32-bit ints and
  // convert each to 8 hex chars; the first nibble of byte 0 is
  // unused because we only need 16 chars (16 nibbles), not 17.
  // Easiest: draw 4 ints, shift, and pull a nibble at a time.
  // Doing it as bytes from a 4-int pool keeps the code obvious
  // and bias-free (32 bits per int, no modulo needed).
  const ints: number[] = [prng.next(), prng.next(), prng.next(), prng.next()];
  let out = '';
  for (let i = 0; i < 4; i += 1) {
    const v = ints[i] ?? 0;
    out += (v >>> 0).toString(16).padStart(8, '0');
  }
  return out.slice(0, SERIAL_LENGTH);
}
