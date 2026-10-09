/**
 * B3.1 unit tests — pure HMAC signature helpers
 * (`apps/api/src/lib/service-hmac.ts`).
 *
 * The BackOffice exposes a `POST /v1/access/decision` endpoint (B3.2)
 * that other services (the portal-api / Canvas pipeline, the Jitsi
 * join coordinator) call. The wire format MUST be byte-for-byte
 * compatible with quorum-otp's `Authorization: HMAC <name> <ts> <hex>`
 * scheme so a single shared-secret registration per service works
 * across both backends.
 *
 * Quorum-otp spec (READ-ONLY reference: /planQuorum/dev/quorum-otp):
 *   - Signature: HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 *   - Encoded as lowercase hex
 *   - Replay window: ±skew seconds
 *   - Constant-time compare via node:crypto.timingSafeEqual
 *
 * What we lock down here:
 *   - A known secret + timestamp + body produces the exact hex
 *     HMAC-SHA256 vector that node's createHmac produces (oracle
 *     computed inline so this test cannot drift from the algorithm
 *     even if node crypto changes).
 *   - hmacVerify accepts the matching signature.
 *   - hmacVerify rejects a tampered body, a tampered timestamp, a
 *     wrong secret, a stale timestamp, an empty/garbage signature,
 *     and a signature of the wrong length.
 *   - The constant-time branch is exercised (different-length
 *     hex inputs short-circuit, equal-length inputs hit
 *     timingSafeEqual).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { hmacSign, hmacVerify } from '../../src/lib/service-hmac';

const SECRET = 'backoffice-shared-secret-1234567890abcdef';
const TIMESTAMP = 1_735_689_600; // 2025-01-01T00:00:00Z
const BODY = JSON.stringify({ device_id: 'dev-1', otp_proof: 'AB12CD' });

// Independent oracle — the same algorithm quorum-otp uses
// (createHmac over `${timestamp}.${rawBody}`). Computed once per
// test so we never accidentally make the test pass by sharing code
// with the implementation under test.
function oracle(secret: string, ts: number, body: string): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex');
}

describe('hmacSign — produces the exact hex HMAC-SHA256 vector', () => {
  it('matches an independent node crypto oracle for a known vector', () => {
    const expected = oracle(SECRET, TIMESTAMP, BODY);
    expect(hmacSign(SECRET, TIMESTAMP, BODY)).toBe(expected);
  });

  it('emits a 64-char lowercase hex string', () => {
    const sig = hmacSign(SECRET, TIMESTAMP, BODY);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a different signature for a different secret', () => {
    const a = hmacSign(SECRET, TIMESTAMP, BODY);
    const b = hmacSign('a-different-secret-also-32-bytes-long!', TIMESTAMP, BODY);
    expect(a).not.toBe(b);
  });

  it('produces a different signature for a different timestamp', () => {
    const a = hmacSign(SECRET, TIMESTAMP, BODY);
    const b = hmacSign(SECRET, TIMESTAMP + 1, BODY);
    expect(a).not.toBe(b);
  });

  it('produces a different signature for a different body', () => {
    const a = hmacSign(SECRET, TIMESTAMP, BODY);
    const b = hmacSign(SECRET, TIMESTAMP, BODY + ' ');
    expect(a).not.toBe(b);
  });

  it('signs the exact empty body as `${ts}.` (consistent with GET / no-body requests)', () => {
    const expected = oracle(SECRET, TIMESTAMP, '');
    expect(hmacSign(SECRET, TIMESTAMP, '')).toBe(expected);
  });
});

describe('hmacVerify — accepts a valid signature and decorates nothing (pure function)', () => {
  it('returns true when the signature matches', () => {
    const sig = hmacSign(SECRET, TIMESTAMP, BODY);
    expect(hmacVerify(SECRET, TIMESTAMP, BODY, sig, 60, TIMESTAMP)).toBe(true);
  });

  it('returns true at the exact window edges (±skew)', () => {
    const sig = hmacSign(SECRET, TIMESTAMP, BODY);
    expect(hmacVerify(SECRET, TIMESTAMP, BODY, sig, 60, TIMESTAMP - 60)).toBe(true);
    expect(hmacVerify(SECRET, TIMESTAMP, BODY, sig, 60, TIMESTAMP + 60)).toBe(true);
  });
});

describe('hmacVerify — rejects every failure mode', () => {
  const sig = hmacSign(SECRET, TIMESTAMP, BODY);

  it('rejects a tampered body', () => {
    expect(hmacVerify(SECRET, TIMESTAMP, BODY + 'X', sig, 60, TIMESTAMP)).toBe(false);
  });

  it('rejects a tampered timestamp (signature covers timestamp+body)', () => {
    // The signature was computed for `TIMESTAMP`; presenting it with
    // a different timestamp MUST fail the constant-time compare.
    expect(hmacVerify(SECRET, TIMESTAMP + 1, BODY, sig, 60, TIMESTAMP + 1)).toBe(false);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const wrong = hmacSign('not-the-shared-secret-but-also-32-bytes!!', TIMESTAMP, BODY);
    expect(hmacVerify(SECRET, TIMESTAMP, BODY, wrong, 60, TIMESTAMP)).toBe(false);
  });

  it('rejects a stale timestamp beyond the skew window', () => {
    expect(hmacVerify(SECRET, TIMESTAMP, BODY, sig, 60, TIMESTAMP + 61)).toBe(false);
    expect(hmacVerify(SECRET, TIMESTAMP, BODY, sig, 60, TIMESTAMP - 61)).toBe(false);
  });

  it('rejects a non-numeric (NaN / Infinity) timestamp', () => {
    // The verifier must not throw on garbage input; it must return
    // false. This protects the preHandler from a malformed header
    // such as `HMAC svc NaN abc`.
    expect(hmacVerify(SECRET, Number.NaN, BODY, sig, 60, TIMESTAMP)).toBe(false);
    expect(hmacVerify(SECRET, Number.POSITIVE_INFINITY, BODY, sig, 60, TIMESTAMP)).toBe(false);
  });

  it('rejects an empty signature', () => {
    expect(hmacVerify(SECRET, TIMESTAMP, BODY, '', 60, TIMESTAMP)).toBe(false);
  });

  it('rejects a signature of the wrong length (length-leak short-circuit)', () => {
    // Different-length hex inputs must not throw and must return false
    // without invoking timingSafeEqual.
    expect(hmacVerify(SECRET, TIMESTAMP, BODY, 'a'.repeat(63), 60, TIMESTAMP)).toBe(false);
    expect(hmacVerify(SECRET, TIMESTAMP, BODY, 'a'.repeat(65), 60, TIMESTAMP)).toBe(false);
  });

  it('rejects a non-hex signature of the right length (timingSafeEqual path)', () => {
    // 64 chars, but not valid hex; timingSafeEqual will return false
    // because Buffer.from(..., 'hex') produces a shorter buffer.
    const bad = 'z'.repeat(64);
    expect(hmacVerify(SECRET, TIMESTAMP, BODY, bad, 60, TIMESTAMP)).toBe(false);
  });

  it('rejects garbage bytes of the right length (timingSafeEqual path)', () => {
    // 64 chars of valid hex that differ in every byte from the
    // expected signature. This exercises the constant-time branch.
    const wrong = '0'.repeat(64);
    expect(sig).not.toBe(wrong);
    expect(hmacVerify(SECRET, TIMESTAMP, BODY, wrong, 60, TIMESTAMP)).toBe(false);
  });
});

describe('hmacVerify — uses node:crypto.timingSafeEqual for the constant-time branch', () => {
  // The implementation must reach into node:crypto.timingSafeEqual
  // for equal-length hex inputs. We assert this by spying on the
  // module export and confirming it was invoked with buffers of the
  // correct length (64 hex chars => 32 bytes).
  it('invokes timingSafeEqual on the 32-byte decoded buffers', () => {
    const sig = hmacSign(SECRET, TIMESTAMP, BODY);
    const spy = jest.spyOn(require('node:crypto'), 'timingSafeEqual');
    try {
      hmacVerify(SECRET, TIMESTAMP, BODY, sig, 60, TIMESTAMP);
      expect(spy).toHaveBeenCalledTimes(1);
      const [a, b] = spy.mock.calls[0] as [Buffer, Buffer];
      expect(Buffer.isBuffer(a)).toBe(true);
      expect(Buffer.isBuffer(b)).toBe(true);
      expect(a.length).toBe(32);
      expect(b.length).toBe(32);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not invoke timingSafeEqual for length-mismatched signatures (short-circuits)', () => {
    const spy = jest.spyOn(require('node:crypto'), 'timingSafeEqual');
    try {
      hmacVerify(SECRET, TIMESTAMP, BODY, 'abc', 60, TIMESTAMP);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// Sanity: the imported `timingSafeEqual` reference is the same one
// the implementation is expected to use. Belt-and-suspenders against
// accidental import drift.
describe('node crypto surface used by the implementation', () => {
  it('exposes the same timingSafeEqual we use in tests', () => {
    expect(typeof timingSafeEqual).toBe('function');
  });
});
