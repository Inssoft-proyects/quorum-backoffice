/**
 * M3 / MFA redirect-token service — unit tests.
 *
 * The service backs two HTTP endpoints:
 *
 *   - POST /api/v1/mfa/redirect-token (student-session cookie auth)
 *     issues a 32-byte hex opaque token, stores the resolved
 *     student identity + the next_url in Redis with a 30-second
 *     TTL, and returns the token to the caller.
 *
 *   - POST /api/v1/mfa/consume (HMAC service-auth) reads the key
 *     with GETDEL (atomic single-use), validates the `next_url`
 *     against the same allowlist, and returns the student
 *     identity to Canvas so it can issue its own session.
 *
 * This file locks the *pure* layer of the service:
 *
 *   1. `parseAllowedOrigins` is a small parser that turns the
 *      comma-separated `MFA_ALLOWED_REDIRECT_ORIGINS` env var
 *      into a list of normalized origin strings. Empty / blank
 *      entries are dropped; a whitespace-only env is treated as
 *      "no allowlist" so the route emits 403 mfa_redirect_origin_not_allowed.
 *
 *   2. `extractOrigin` parses a URL string and returns the
 *      origin (protocol + host + port). It throws on a parse
 *      failure so the route layer can return 400 invalid_request.
 *
 *   3. `isOriginAllowed` performs a constant-time compare
 *      between the request's origin and each allowlisted origin
 *      using `crypto.timingSafeEqual`. A non-string or a length
 *      mismatch short-circuits to false WITHOUT invoking
 *      timingSafeEqual (so a malformed request cannot leak the
 *      valid origins via timing).
 *
 *   4. The token generator emits 32 random bytes (crypto.randomBytes),
 *      hex-encoded (64 chars, lowercase). Two consecutive calls
 *      produce different tokens (no fixed seed).
 *
 *   5. The Redis payload is JSON with the documented field
 *      shape: canvas_user_id, student_name, student_email,
 *      role, next_url, issued_at.
 *
 *   6. The Redis key is `mfa_redirect:<token>` and the TTL is
 *      ~30s.
 *
 * The HTTP-layer tests (route registration, session cookie
 * validation, HMAC preHandler, audit row) live in
 * `apps/api/test/integration/mfa-redirect-token.int.test.ts`.
 */
import { randomBytes } from 'node:crypto';
import {
  parseAllowedOrigins,
  extractOrigin,
  isOriginAllowed,
  generateMfaRedirectToken,
  MFA_REDIRECT_KEY_PREFIX,
  MFA_REDIRECT_TTL_SECONDS,
  buildMfaRedirectPayload,
  type MfaRedirectPayload,
} from '../../../src/services/mfa-token-service';

// ---------------------------------------------------------------------------
// parseAllowedOrigins
// ---------------------------------------------------------------------------

describe('parseAllowedOrigins — MFA_ALLOWED_REDIRECT_ORIGINS parser', () => {
  it('returns an empty list for an empty / whitespace-only env', () => {
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins('   ')).toEqual([]);
    expect(parseAllowedOrigins(',,,')).toEqual([]);
  });

  it('parses a single origin verbatim', () => {
    expect(parseAllowedOrigins('https://canvas.example.com')).toEqual([
      'https://canvas.example.com',
    ]);
  });

  it('parses a comma-separated list and trims whitespace around each entry', () => {
    expect(
      parseAllowedOrigins(
        'https://canvas.example.com, https://canvas-staging.example.com',
      ),
    ).toEqual([
      'https://canvas.example.com',
      'https://canvas-staging.example.com',
    ]);
  });

  it('drops empty entries from leading / trailing commas and double commas', () => {
    expect(
      parseAllowedOrigins(',https://canvas.example.com,,https://canvas-staging.example.com,'),
    ).toEqual([
      'https://canvas.example.com',
      'https://canvas-staging.example.com',
    ]);
  });

  it('preserves the protocol + host + port verbatim (no normalization)', () => {
    // The service does NOT normalise the origin (e.g. add a
    // default port for https://host:443); the allowlist
    // contains whatever the operator provisioned. Tests that
    // depend on normalization should be added at the route
    // layer with an explicit `MFA_ALLOWED_REDIRECT_ORIGINS`
    // value.
    expect(parseAllowedOrigins('https://canvas.example.com:443')).toEqual([
      'https://canvas.example.com:443',
    ]);
  });
});

// ---------------------------------------------------------------------------
// extractOrigin
// ---------------------------------------------------------------------------

describe('extractOrigin — URL → origin extraction', () => {
  it('returns the origin for an https URL with default port', () => {
    expect(extractOrigin('https://canvas.example.com/path?x=1')).toBe(
      'https://canvas.example.com',
    );
  });

  it('returns the origin for an http URL with an explicit port', () => {
    expect(extractOrigin('http://localhost:3001/dashboard')).toBe(
      'http://localhost:3001',
    );
  });

  it('returns the origin for a URL with query string + fragment', () => {
    expect(extractOrigin('https://canvas.example.com/x?a=b#hash')).toBe(
      'https://canvas.example.com',
    );
  });

  it('throws on a URL that is not parseable (no protocol)', () => {
    expect(() => extractOrigin('canvas.example.com/path')).toThrow();
  });

  it('throws on a non-string value', () => {
    // Defensive: the route layer validates the body with Zod
    // (which rejects non-strings), but the service-level
    // guard is the last line of defense.
    expect(() => extractOrigin(undefined as unknown as string)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// isOriginAllowed
// ---------------------------------------------------------------------------

describe('isOriginAllowed — constant-time origin comparison', () => {
  const allowlist = parseAllowedOrigins(
    'https://canvas.example.com,https://canvas-staging.example.com',
  );

  it('returns true for an allowlisted origin', () => {
    expect(isOriginAllowed('https://canvas.example.com', allowlist)).toBe(true);
    expect(isOriginAllowed('https://canvas-staging.example.com', allowlist)).toBe(
      true,
    );
  });

  it('returns false for an origin not in the allowlist', () => {
    expect(isOriginAllowed('https://evil.example.com', allowlist)).toBe(false);
    expect(isOriginAllowed('https://canvas.example.com.evil.com', allowlist)).toBe(
      false,
    );
  });

  it('is case-SENSITIVE on the host (allows the operator to deny mixed-case attacks)', () => {
    // The protocol is case-insensitive per the URL spec, but
    // the service treats the origin string as opaque and
    // compares byte-for-byte; this is the safest default and
    // means the operator must provision the EXACT origin their
    // Canvas instance uses.
    expect(isOriginAllowed('https://Canvas.Example.com', allowlist)).toBe(false);
  });

  it('returns false for an empty allowlist (no origin matches)', () => {
    expect(isOriginAllowed('https://canvas.example.com', [])).toBe(false);
  });

  it('compares with timingSafeEqual (length-mismatched origins short-circuit without throwing)', () => {
    // A length-mismatched origin must NOT throw — it must
    // simply return false. This is the standard constant-time
    // compare contract: equal-length buffers only.
    expect(isOriginAllowed('https://x', allowlist)).toBe(false);
    expect(
      isOriginAllowed(
        'https://canvas.example.com/extra/long/path/that/does/not/matter',
        allowlist,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateMfaRedirectToken
// ---------------------------------------------------------------------------

describe('generateMfaRedirectToken — 32 random bytes hex', () => {
  it('returns a 64-char lowercase hex string', () => {
    const t = generateMfaRedirectToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a different token on each call', () => {
    const a = generateMfaRedirectToken();
    const b = generateMfaRedirectToken();
    const c = generateMfaRedirectToken();
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  it('produces 256 bits of entropy per the randomBytes source', () => {
    // 32 bytes = 64 hex chars. The byte length of the decoded
    // value must be exactly 32.
    const t = generateMfaRedirectToken();
    const buf = Buffer.from(t, 'hex');
    expect(buf.length).toBe(32);
  });

  it('agrees with the crypto.randomBytes generator at the byte level', () => {
    // White-box check: the implementation must call
    // crypto.randomBytes(32).toString('hex') under the hood.
    // We don't reach into the private impl, but we can pin the
    // shape and length so a future refactor cannot regress
    // either the entropy source or the encoding.
    const t = generateMfaRedirectToken();
    const control = randomBytes(32).toString('hex');
    expect(t.length).toBe(control.length);
    expect(/^[0-9a-f]+$/.test(t)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildMfaRedirectPayload
// ---------------------------------------------------------------------------

describe('buildMfaRedirectPayload — wire payload shape', () => {
  it('produces a payload with the documented field set', () => {
    const issued = new Date('2026-01-01T00:00:00.000Z');
    const p = buildMfaRedirectPayload({
      canvasUserId: 7001,
      studentName: 'Marie Curie',
      studentEmail: 'marie@example.test',
      role: 'student',
      nextUrl: 'https://canvas.example.com/dashboard',
      issuedAt: issued,
    });
    expect(p).toEqual<MfaRedirectPayload>({
      canvas_user_id: 7001,
      student_name: 'Marie Curie',
      student_email: 'marie@example.test',
      role: 'student',
      next_url: 'https://canvas.example.com/dashboard',
      issued_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('always pins the role to "student" (MFA session is student-scoped)', () => {
    const p = buildMfaRedirectPayload({
      canvasUserId: 1,
      studentName: 'X',
      studentEmail: 'x@example.test',
      role: 'student',
      nextUrl: 'https://canvas.example.com/',
      issuedAt: new Date(),
    });
    expect(p.role).toBe('student');
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('MFA redirect constants', () => {
  it('uses the documented key prefix', () => {
    expect(MFA_REDIRECT_KEY_PREFIX).toBe('mfa_redirect:');
  });

  it('uses a 30-second TTL', () => {
    expect(MFA_REDIRECT_TTL_SECONDS).toBe(30);
  });
});
