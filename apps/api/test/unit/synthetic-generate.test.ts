/**
 * Unit tests for the pure generation helpers in
 * apps/api/scripts/synthetic/lib/generate.ts.
 *
 * These are the foundation of both the Canvas seeder and the
 * backoffice DB seeder. They MUST be deterministic from a seed
 * (so the operator can re-run the same fixture byte-for-byte),
 * MUST produce only 6-char `[A-Z0-9]` matriculas, MUST produce
 * only 16-char lowercase hex serial numbers, and MUST be unique
 * across the size of a run (1000+ entries).
 *
 * Coverage:
 *  - determinism: same seed -> same sequence (byte equality)
 *  - cross-seed difference: different seeds -> different sequences
 *  - matricula charset + length on every output of a 1000-element run
 *  - serial charset + length on every output of a 1000-element run
 *  - uniqueness on a 1000-element run for both generators
 *  - first serial of a default-seed device run is exactly the
 *    constant `f401e1afcfd09b16` (used for MFA smoke testing)
 *  - generateMatriculas never produces the placeholder strings
 *    `MARBES` / `MARBET` (defensive: the marbete prefix and a
 *    typo) so the run can never collide with a real SIS id
 *    pattern by accident.
 */
import {
  generateMatriculas,
  generateDeviceSerials,
  createPrng,
  type Prng,
} from '../../scripts/synthetic/lib/generate';
import {
  buildCreateUserPath,
  DEFAULT_CANVAS_ACCOUNT_ID,
} from '../../scripts/synthetic/canvas-students';

const MATRICULA_REGEX = /^[A-Z0-9]{6}$/;
const SERIAL_REGEX = /^[0-9a-f]{16}$/;
const DEFAULT_SEED = 'quorum-synthetic-v1';
const MFA_FIRST_SERIAL = 'f401e1afcfd09b16';

describe('synthetic/lib/generate — createPrng', () => {
  it('returns the same sequence for the same seed', () => {
    const a = createPrng(DEFAULT_SEED);
    const b = createPrng(DEFAULT_SEED);
    for (let i = 0; i < 32; i += 1) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('returns different sequences for different seeds', () => {
    const a = createPrng('seed-a');
    const b = createPrng('seed-b');
    // 32 samples is enough to collide with negligible probability
    // (a same-seed collision already happened above, so a cross-
    // seed equality at the very first sample is astronomically
    // unlikely for the SFMT-style 32-bit range we use here).
    let same = 0;
    for (let i = 0; i < 32; i += 1) {
      if (a.next() === b.next()) same += 1;
    }
    expect(same).toBeLessThan(4);
  });
});

describe('synthetic/lib/generate — generateMatriculas', () => {
  it('produces exactly N entries', () => {
    const out = generateMatriculas({ seed: DEFAULT_SEED, count: 250 });
    expect(out).toHaveLength(250);
  });

  it('every entry matches /^[A-Z0-9]{6}$/ on a 1000-element run', () => {
    const out = generateMatriculas({ seed: DEFAULT_SEED, count: 1000 });
    for (const m of out) {
      expect(m).toMatch(MATRICULA_REGEX);
    }
  });

  it('is deterministic from the same seed (byte-equal across two runs)', () => {
    const a = generateMatriculas({ seed: DEFAULT_SEED, count: 1000 });
    const b = generateMatriculas({ seed: DEFAULT_SEED, count: 1000 });
    expect(a).toEqual(b);
  });

  it('differs across seeds for the same count', () => {
    const a = generateMatriculas({ seed: 'seed-a', count: 1000 });
    const b = generateMatriculas({ seed: 'seed-b', count: 1000 });
    // At least 900 of 1000 entries must differ. The probability of
    // a single 6-char `[A-Z0-9]` collision between two independent
    // sequences is ~1/36^6, so 900/1000 differing is overwhelmingly
    // the expected outcome and a safety net for any future bug
    // that accidentally ties both outputs to the same PRNG state.
    let same = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] === b[i]) same += 1;
    }
    expect(same).toBeLessThan(100);
  });

  it('is unique across a 1000-element run', () => {
    const out = generateMatriculas({ seed: DEFAULT_SEED, count: 1000 });
    const set = new Set(out);
    expect(set.size).toBe(out.length);
  });

  it('never emits the placeholder strings MARBES / MARBET', () => {
    // Defensive: the marbete "public_uid" prefix is `m-` followed
    // by 4 alphabet chars from a 31-char alphabet that contains
    // neither `MARBES` nor `MARBET`; this pins the property at
    // the matricula layer too, where a coincidence would be more
    // confusing.
    const out = generateMatriculas({ seed: DEFAULT_SEED, count: 1000 });
    for (const m of out) {
      expect(m).not.toBe('MARBES');
      expect(m).not.toBe('MARBET');
    }
  });
});

describe('synthetic/lib/generate — generateDeviceSerials', () => {
  it('produces exactly N entries', () => {
    const out = generateDeviceSerials({ seed: DEFAULT_SEED, count: 250 });
    expect(out).toHaveLength(250);
  });

  it('every entry matches /^[0-9a-f]{16}$/ on a 1000-element run', () => {
    const out = generateDeviceSerials({ seed: DEFAULT_SEED, count: 1000 });
    for (const s of out) {
      expect(s).toMatch(SERIAL_REGEX);
    }
  });

  it('is deterministic from the same seed (byte-equal across two runs)', () => {
    const a = generateDeviceSerials({ seed: DEFAULT_SEED, count: 1000 });
    const b = generateDeviceSerials({ seed: DEFAULT_SEED, count: 1000 });
    expect(a).toEqual(b);
  });

  it('is unique across a 1000-element run', () => {
    const out = generateDeviceSerials({ seed: DEFAULT_SEED, count: 1000 });
    const set = new Set(out);
    expect(set.size).toBe(out.length);
  });

  it('the FIRST serial of a default-seed run is exactly f401e1afcfd09b16 (MFA smoke fixture)', () => {
    // The MFA smoke test exercises a 3-step lookup (marbete code
    // -> student, device serial -> student) and needs the first
    // device serial to be a known constant so the operator can
    // type it into a test harness without copy-pasting from the
    // mapping JSON. We pin the first serial as a literal in the
    // generator (NOT derived from the PRNG) so it can never drift
    // across seed changes. Subsequent serials (index >= 1) ARE
    // derived from the seed for reproducibility.
    const out = generateDeviceSerials({ seed: DEFAULT_SEED, count: 4 });
    expect(out[0]).toBe(MFA_FIRST_SERIAL);
    // The next three serials must be deterministic from the seed.
    const again = generateDeviceSerials({ seed: DEFAULT_SEED, count: 4 });
    expect(out.slice(1)).toEqual(again.slice(1));
  });

  it('throws when asked for zero or negative count', () => {
    expect(() => generateDeviceSerials({ seed: DEFAULT_SEED, count: 0 })).toThrow();
    expect(() => generateDeviceSerials({ seed: DEFAULT_SEED, count: -1 })).toThrow();
    expect(() => generateMatriculas({ seed: DEFAULT_SEED, count: 0 })).toThrow();
    expect(() => generateMatriculas({ seed: DEFAULT_SEED, count: -1 })).toThrow();
  });
});

describe('synthetic/lib/generate — createPrng (PRNG contract)', () => {
  it('exposes a uniform 32-bit integer in [0, 2^32) on every call', () => {
    const p: Prng = createPrng(DEFAULT_SEED);
    for (let i = 0; i < 1000; i += 1) {
      const v = p.next();
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      // Strict upper bound: < 2^32
      expect(v).toBeLessThan(2 ** 32);
    }
  });
});

describe('synthetic/canvas-students — buildCreateUserPath', () => {
  it('pins the Quorum production default to account id 2 (NOT 1)', () => {
    // Live-fact: account id 1 does not exist for the production
    // token; the tenant's actual root account is id 2 (verified
    // via `GET /api/v1/accounts/2` returning parent_account_id=null).
    // We pin this so a future refactor cannot silently regress to
    // the Canvas-default id 1, which would break every re-run.
    expect(DEFAULT_CANVAS_ACCOUNT_ID).toBe(2);
  });

  it('builds the expected path for a positive integer account id', () => {
    expect(buildCreateUserPath(2)).toBe('/api/v1/accounts/2/users');
    expect(buildCreateUserPath(7)).toBe('/api/v1/accounts/7/users');
    expect(buildCreateUserPath(12345)).toBe('/api/v1/accounts/12345/users');
  });

  it('throws on zero, negative, or non-integer account ids', () => {
    expect(() => buildCreateUserPath(0)).toThrow();
    expect(() => buildCreateUserPath(-1)).toThrow();
    expect(() => buildCreateUserPath(1.5)).toThrow();
    expect(() => buildCreateUserPath(Number.NaN)).toThrow();
    expect(() => buildCreateUserPath(Number.POSITIVE_INFINITY)).toThrow();
  });
});
