/**
 * Pure HMAC-SHA256 signature helpers for the inbound service-auth
 * surface.
 *
 * The wire format is intentionally identical to the one used by
 * `quorum-otp` (see /planQuorum/dev/quorum-otp/src/services/token-crypto.ts
 * and /planQuorum/dev/quorum-otp/src/plugins/auth.ts) so a single
 * shared-secret registration per service (e.g. `canvas-portal`)
 * works across both backends:
 *
 *   Header:    Authorization: HMAC <service-name> <unix-ts> <hex-sig>
 *   Signature: HMAC-SHA256(secret, `${timestamp}.${rawBody}`) → hex
 *
 * The `rawBody` is the exact request body string captured BEFORE
 * JSON parse (see `captureRawBodyPlugin` in `plugins/service-auth.ts`).
 * For requests with no body (GET / no-payload) the body is the
 * empty string and the signed string is `${ts}.`.
 *
 * Both functions are pure: no Fastify, no env, no I/O. They are
 * covered by `apps/api/test/unit/service-hmac.test.ts`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** A 64-char lowercase hex SHA-256 output. */
const HEX_SHA256_LENGTH = 64;

/**
 * Sign a (timestamp, rawBody) pair under the given shared secret.
 *
 * @param secret    The shared secret bound to the service name in
 *                  `BACKOFFICE_SERVICE_TOKENS`.
 * @param timestamp Unix epoch in seconds.
 * @param rawBody   The exact request body string the sender signed
 *                  (empty string for GET / no-payload requests).
 * @returns 64-char lowercase hex HMAC-SHA256.
 */
export function hmacSign(secret: string, timestamp: number, rawBody: string): string {
  const payload = `${timestamp}.${rawBody}`;
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/**
 * Constant-time compare of a candidate signature against the
 * expected one for `(secret, timestamp, rawBody)`, gated by a
 * ±skew-second clock window.
 *
 * The function is total: it never throws and never reveals which
 * check failed (skew vs signature). It is safe to call on
 * attacker-controlled input from a request preHandler.
 *
 * @param secret       The shared secret bound to the service name.
 * @param timestamp    Unix epoch in seconds (from the header).
 * @param rawBody      The exact request body string the server
 *                     captured for this request (empty string for
 *                     GET / no-payload).
 * @param signature    The hex signature from the header.
 * @param skewSeconds  Maximum allowed |now - timestamp|.
 * @param now          Wall-clock provider (overridable in tests).
 */
export function hmacVerify(
  secret: string,
  timestamp: number,
  rawBody: string,
  signature: string,
  skewSeconds: number,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  // Garbage in the header (e.g. `HMAC svc NaN abc`) must not throw
  // and must return false. `Number.isFinite` rejects NaN, +Inf, -Inf
  // and any value that JS would not treat as a usable number.
  if (!Number.isFinite(timestamp)) return false;
  // Skew is an absolute value: a clock that is 5 minutes in the
  // past and a clock that is 5 minutes in the future both fail
  // the same way.
  const skew = Math.abs(now - timestamp);
  if (skew > skewSeconds) return false;
  // Length-mismatched signatures short-circuit without invoking
  // timingSafeEqual. SHA-256 hex is always 64 chars, so any
  // different length is guaranteed to be invalid; this is also
  // the only way the function never feeds malformed hex into
  // Buffer.from(..., 'hex') (which silently truncates).
  if (typeof signature !== 'string' || signature.length !== HEX_SHA256_LENGTH) return false;
  const expected = hmacSign(secret, timestamp, rawBody);
  // Both buffers are 32 bytes; timingSafeEqual requires equal
  // lengths and the lengths are guaranteed by the check above.
  // Wrap in try/catch defensively: Buffer.from with a non-hex
  // char throws "Invalid hex character", which we never want to
  // surface as an unhandled exception from a preHandler.
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}
