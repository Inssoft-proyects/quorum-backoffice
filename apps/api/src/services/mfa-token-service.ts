/**
 * M3 / MFA redirect-token service.
 *
 * Backs the two endpoints of the SSO redirect flow:
 *
 *   - `issueToken` is called by the MFA web page AFTER a
 *     successful POST /api/v1/mfa/authenticate. The caller has
 *     a valid `__Host-mfa_sid` student session and the
 *     resolved student identity; the service mints a 32-byte
 *     hex opaque token, stores the identity + the `next_url`
 *     in Redis with a 30-second TTL, and returns the token.
 *
 *   - `consumeToken` is called by Canvas (server-to-server,
 *     HMAC service-auth) when the user lands on Canvas with
 *     `?mfa_token=<token>` in the URL. The service uses
 *     `GETDEL` to atomically read + delete the key (so a
 *     concurrent replay of the same token is impossible), and
 *     returns the student identity to Canvas so it can issue
 *     its own session.
 *
 * Origin validation policy:
 *
 *   The `MFA_ALLOWED_REDIRECT_ORIGINS` env var is a
 *   comma-separated list of allowed origins
 *   (`https://canvas.example.com,https://canvas-staging.example.com`).
 *   The comparison is on the ORIGIN only (protocol + host + port),
 *   not the full URL. Same-origin paths (`/dashboard`) are
 *   accepted when their origin is the configured
 *   `BACKOFFICE_URL` (a same-origin browser redirect is
 *   always safe), but the M3 plan keeps the allowlist to
 *   external origins only — the MFA web page uses a same-origin
 *   `router.push` for backoffice paths and a cross-origin
 *   `window.location.href` for Canvas.
 *
 *   The compare uses `crypto.timingSafeEqual` over the
 *   byte-equality of the two origin strings. A length mismatch
 *   short-circuits to false without invoking timingSafeEqual
 *   (so a malformed request cannot leak the valid origins via
 *   timing).
 *
 * Security contracts:
 *
 *   - Tokens are 32 random bytes from `crypto.randomBytes`,
 *     hex-encoded. 256 bits of entropy.
 *   - Tokens are stored in Redis with a 30-second TTL. After
 *     the TTL elapses, the key disappears naturally; the
 *     consume path does NOT extend it.
 *   - One-time use is enforced at the Redis level via GETDEL
 *     (atomic read + delete). The consume path never does
 *     separate GET + DEL.
 *   - The token is NEVER logged at INFO / WARN / ERROR level.
 *     The warn log on the consume-deny path identifies the
 *     deny code only; the audit row carries the same.
 *   - The `next_url` is never echoed in deny responses or in
 *     the audit row beyond the value itself (no token, no
 *     internal ids).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../lib/errors';
import { AuditService } from './audit-service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Redis key prefix for the M3 redirect-token map. The full
 * key shape is `mfa_redirect:<64-hex-token>`. The prefix is
 * exported as a constant so the route layer, the service, and
 * the tests share a single source of truth.
 */
export const MFA_REDIRECT_KEY_PREFIX = 'mfa_redirect:';

/**
 * Token TTL in seconds. 30s is the documented contract — the
 * MFA web page must construct the `?mfa_token=` URL within 30
 * seconds of the issue call. Tests pin this value.
 */
export const MFA_REDIRECT_TTL_SECONDS = 30;

// ---------------------------------------------------------------------------
// Origin allowlist — pure parser / comparator
// ---------------------------------------------------------------------------

/**
 * Parse `MFA_ALLOWED_REDIRECT_ORIGINS` into a list of normalized
 * origin strings. Tolerant of leading / trailing whitespace,
 * double commas, and empty entries (which are dropped). The
 * service does NOT canonicalize the origin (e.g. lower-case the
 * host, strip the default port); the operator must provision
 * the EXACT origin their Canvas instance uses. This keeps the
 * compare byte-exact and the audit log human-readable.
 *
 * Whitespace-only / empty input returns an empty list, which
 * causes every origin to be rejected (fail-closed).
 */
export function parseAllowedOrigins(raw: string): string[] {
  if (typeof raw !== 'string') return [];
  const out: string[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * Extract the origin (protocol + host + port) from a URL
 * string. Throws on a parse failure (e.g. the string is not a
 * URL); the route layer maps the throw to 400 invalid_request.
 *
 * `URL` is the WHATWG parser; for inputs like
 * `https://canvas.example.com/path?x=1#y` it returns
 * `https://canvas.example.com` (no trailing slash, no path).
 */
export function extractOrigin(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new TypeError('next_url must be a non-empty string');
  }
  // The WHATWG URL constructor throws on garbage; we surface
  // the same TypeError to the route layer.
  const u = new URL(raw);
  return u.origin;
}

/**
 * Constant-time comparison of a candidate origin against a
 * list of allowlisted origins. Returns true if any allowlisted
 * origin matches the candidate EXACTLY (byte-for-byte).
 *
 * A length mismatch short-circuits to false WITHOUT invoking
 * `timingSafeEqual` (the standard constant-time compare
 * contract requires equal-length buffers). A non-string
 * candidate also short-circuits. Both paths run in
 * `Array.prototype.some` which is acceptable for the size of
 * the allowlist (typically 1-3 entries).
 */
export function isOriginAllowed(candidate: string, allowlist: string[]): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
  const candidateBytes = Buffer.from(candidate, 'utf8');
  for (const allowed of allowlist) {
    if (typeof allowed !== 'string' || allowed.length === 0) continue;
    if (allowed.length !== candidate.length) continue;
    const allowedBytes = Buffer.from(allowed, 'utf8');
    try {
      if (timingSafeEqual(allowedBytes, candidateBytes)) return true;
    } catch {
      // timingSafeEqual throws only on a length mismatch
      // (which we already filter above). Defensive: a future
      // Node change that adds other failure modes should not
      // bubble up from the preHandler-style service.
      continue;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Token generator
// ---------------------------------------------------------------------------

/**
 * Generate a fresh 32-byte hex token. 256 bits of entropy
 * from `crypto.randomBytes`. The string is 64 chars of
 * lowercase hex. Two consecutive calls produce different
 * tokens (the underlying RNG is seeded from `/dev/urandom`).
 */
export function generateMfaRedirectToken(): string {
  return randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// Payload shape
// ---------------------------------------------------------------------------

/**
 * The JSON payload stored in Redis under the
 * `mfa_redirect:<token>` key. The shape is the wire contract
 * with the consume endpoint — the route layer passes it back
 * to Canvas unchanged (minus any internal-only fields). The
 * `role` is always `'student'` for an MFA session.
 *
 * Since migration 0020_students_sis_id.sql: `student_name` and
 * `student_email` are nullable. A synthetic high-privacy student
 * (sis_id + canvas_user_id only) has NULL PII and the redirect
 * payload surfaces `null` for those fields. The MFA chain still
 * requires an active student record at the issuing endpoint, so
 * the loosen here is purely a wire-level forward-compat change.
 */
export interface MfaRedirectPayload {
  canvas_user_id: number;
  student_name: string | null;
  student_email: string | null;
  role: 'student';
  next_url: string;
  issued_at: string;
}

/**
 * Internal input type — the route layer passes the resolved
 * student identity + the validated `next_url` + the issuance
 * timestamp; the service returns the wire-shape payload.
 */
export interface MfaRedirectInput {
  canvasUserId: number;
  studentName: string | null;
  studentEmail: string | null;
  role: 'student';
  nextUrl: string;
  issuedAt: Date;
}

/**
 * Build the Redis payload. Centralized so the wire shape is
 * identical on the issue and consume paths; a refactor that
 * adds a new field touches this one function.
 */
export function buildMfaRedirectPayload(
  input: MfaRedirectInput,
): MfaRedirectPayload {
  return {
    canvas_user_id: input.canvasUserId,
    student_name: input.studentName,
    student_email: input.studentEmail,
    role: 'student',
    next_url: input.nextUrl,
    issued_at: input.issuedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Minimal Redis interface used by the service. Matches the
 * shape of `app.redis` declared in `plugins/redis.ts` so the
 * service can be constructed with the live app.redis without
 * any further plumbing.
 */
export interface MfaRedirectRedisLike {
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<'OK'>;
}

export interface MfaTokenServiceDeps {
  redis: MfaRedirectRedisLike;
  pool: pg.Pool;
  log: FastifyBaseLogger;
  allowedOrigins: string[];
}

export interface MfaIssueInput {
  canvasUserId: number;
  studentName: string | null;
  studentEmail: string | null;
  nextUrl: string;
}

export interface MfaIssueResult {
  token: string;
  expiresIn: number;
}

export interface MfaConsumeResult {
  canvasUserId: number;
  studentName: string | null;
  studentEmail: string | null;
  role: 'student';
  nextUrl: string;
}

/**
 * The MFA redirect-token service. Two public methods:
 *
 *   - `issueToken` (called by the MFA web page via the
 *     /api/v1/mfa/redirect-token route): validates the origin
 *     against the allowlist, mints a fresh token, and stores
 *     the payload in Redis with a 30-second TTL.
 *
 *   - `consumeToken` (called by Canvas via the
 *     /api/v1/mfa/consume route, HMAC auth enforced upstream):
 *     uses `GETDEL` to atomically read + delete the key, and
 *     validates the origin again. On a deny path it throws
 *     `AppError('mfa_token_invalid', ..., 401)` and writes an
 *     audit row + a warn log; the raw token is never logged.
 */
export class MfaTokenService {
  private readonly redis: MfaRedirectRedisLike;
  private readonly pool: pg.Pool;
  private readonly log: FastifyBaseLogger;
  private readonly allowedOrigins: string[];

  constructor(deps: MfaTokenServiceDeps) {
    this.redis = deps.redis;
    this.pool = deps.pool;
    this.log = deps.log;
    this.allowedOrigins = deps.allowedOrigins;
  }

  /**
   * Validate `nextUrl` against the allowlist, mint a fresh
   * token, and store the payload. Throws:
   *
   *   - `AppError('mfa_redirect_origin_not_allowed', ..., 403)`
   *     when the origin is not in `MFA_ALLOWED_REDIRECT_ORIGINS`.
   *   - `AppError('validation_error', ..., 400)` when the URL
   *     is not parseable (the route layer normally catches
   *     this with Zod; the service-level guard is the last
   *     line of defense).
   */
  async issueToken(input: MfaIssueInput): Promise<MfaIssueResult> {
    // Parse the URL and extract the origin. extractOrigin
    // throws on a non-URL; the route's Zod schema already
    // gates this, but the service-level guard prevents a
    // future refactor from regressing the wire contract.
    let origin: string;
    try {
      origin = extractOrigin(input.nextUrl);
    } catch (err) {
      // The WHATWG URL parser throws TypeError('Invalid URL')
      // on garbage input. Map to a 400 invalid_request so the
      // route layer surfaces a stable wire code rather than
      // leaking the parser's exception.
      this.log.warn(
        { reason: 'malformed_next_url' },
        'mfa_redirect_token_invalid_request',
      );
      throw new AppError(
        'invalid_request',
        `next_url is not a parseable URL: ${(err as Error).message}`,
        400,
      );
    }

    // Allowlist check (constant-time compare). Empty
    // allowlist → every origin rejected (fail-closed).
    if (!isOriginAllowed(origin, this.allowedOrigins)) {
      throw new AppError(
        'mfa_redirect_origin_not_allowed',
        'next_url origin is not in the MFA allowlist',
        403,
      );
    }

    const token = generateMfaRedirectToken();
    const payload = buildMfaRedirectPayload({
      canvasUserId: input.canvasUserId,
      studentName: input.studentName,
      studentEmail: input.studentEmail,
      role: 'student',
      nextUrl: input.nextUrl,
      issuedAt: new Date(),
    });

    await this.redis.set(
      `${MFA_REDIRECT_KEY_PREFIX}${token}`,
      JSON.stringify(payload),
      MFA_REDIRECT_TTL_SECONDS,
    );

    return {
      token,
      expiresIn: MFA_REDIRECT_TTL_SECONDS,
    };
  }

  /**
   * Atomically read + delete the token from Redis, validate
   * the payload, and return the student identity. On every
   * documented deny path (unknown, expired, already consumed,
   * allowlist mismatch, malformed JSON) throws
   * `AppError('mfa_token_invalid', ..., 401)` and writes the
   * deny audit row + a warn log.
   *
   * On success, writes the `ok` audit row and returns the
   * `MfaConsumeResult` so the route layer can return it
   * verbatim to Canvas.
   */
  async consumeToken(
    token: string,
    meta: { ip: string | null; userAgent: string | null; serviceCaller: string | null },
  ): Promise<MfaConsumeResult> {
    if (typeof token !== 'string' || token.length === 0) {
      await this.denyAudit(null, meta, 'mfa_token_invalid');
      this.log.warn(
        { reason: 'missing_token', service_caller: meta.serviceCaller, ip: meta.ip },
        'mfa_consume_denied',
      );
      throw new AppError('mfa_token_invalid', 'token is missing', 401);
    }

    // GETDEL: the Redis-level atomic read+delete. Concurrent
    // calls for the same token will see exactly one winner
    // (the value) and one loser (null). The loser is mapped
    // to the same deny envelope as the unknown-id case so an
    // attacker cannot distinguish "never existed" from
    // "already consumed" by the wire response.
    const raw = await this.redis.getdel(`${MFA_REDIRECT_KEY_PREFIX}${token}`);
    if (raw === null) {
      await this.denyAudit(null, meta, 'mfa_token_invalid');
      this.log.warn(
        { reason: 'unknown_or_consumed', service_caller: meta.serviceCaller, ip: meta.ip },
        'mfa_consume_denied',
      );
      throw new AppError('mfa_token_invalid', 'token is unknown or already consumed', 401);
    }

    // The TTL may have elapsed between the issue call and
    // this consume call; GETDEL still returns the value
    // because Redis removes the key only AFTER the TTL fires
    // AND a command reaches it. A TTL-elapsed token shows up
    // as a `null` GETDEL (Redis has already evicted it) so
    // the unknown-or-consumed branch above catches it.
    let payload: MfaRedirectPayload;
    try {
      payload = JSON.parse(raw) as MfaRedirectPayload;
    } catch {
      await this.denyAudit(null, meta, 'mfa_token_invalid');
      this.log.warn(
        { reason: 'malformed_payload', service_caller: meta.serviceCaller, ip: meta.ip },
        'mfa_consume_denied',
      );
      throw new AppError('mfa_token_invalid', 'token payload is malformed', 401);
    }

    // Re-validate the origin. The allowlist may have been
    // tightened between the issue call and this consume
    // call; the consume path must NOT trust the origin that
    // was valid at issue time. Same constant-time compare.
    let origin: string;
    try {
      origin = extractOrigin(payload.next_url);
    } catch {
      await this.denyAudit(null, meta, 'mfa_token_invalid');
      this.log.warn(
        { reason: 'malformed_next_url', service_caller: meta.serviceCaller, ip: meta.ip },
        'mfa_consume_denied',
      );
      throw new AppError('mfa_token_invalid', 'token next_url is malformed', 401);
    }
    if (!isOriginAllowed(origin, this.allowedOrigins)) {
      await this.denyAudit(payload, meta, 'mfa_token_invalid');
      this.log.warn(
        { reason: 'origin_not_allowed', service_caller: meta.serviceCaller, ip: meta.ip },
        'mfa_consume_denied',
      );
      // Surface the same wire code as the other deny paths
      // (mfa_token_invalid) so an attacker cannot distinguish
      // the origin-mismatch case from the unknown-token case
      // at the wire boundary.
      throw new AppError('mfa_token_invalid', 'token origin is not in the MFA allowlist', 401);
    }

    // Audit row for the successful consume. entity_id is
    // the canvas_user_id (the same wire identifier the OTP
    // and the student session were keyed to) so an operator
    // can pivot by canvas user without joining on any other
    // table. The audit row NEVER contains the raw token.
    const audit = new AuditService(this.pool);
    await audit.write({
      actorId: meta.serviceCaller ?? 'unknown_caller',
      action: 'student.mfa_consume',
      entityType: 'student',
      entityId: String(payload.canvas_user_id),
      metadata: {
        outcome: 'ok',
        next_url: payload.next_url,
        // session_origin_ip and user_agent are the metadata
        // requested by the M3 plan; the actor_ip column on
        // the audit row carries the request's IP for the
        // standard "who triggered this event" view.
        session_origin_ip: meta.ip,
        user_agent: meta.userAgent,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      canvasUserId: payload.canvas_user_id,
      studentName: payload.student_name,
      studentEmail: payload.student_email,
      role: 'student',
      nextUrl: payload.next_url,
    };
  }

  /**
   * Internal: write the deny audit row. The `payload` is
   * null on the unknown-token / missing-token paths (we
   * don't have a canvas_user_id to attribute to). The deny
   * code is folded into the after_jsonb `outcome` field so
   * the audit reads (via /api/v1/audit) can pivot by code.
   */
  private async denyAudit(
    payload: MfaRedirectPayload | null,
    meta: { ip: string | null; userAgent: string | null; serviceCaller: string | null },
    outcome: 'mfa_token_invalid' | 'mfa_redirect_origin_not_allowed',
  ): Promise<void> {
    const audit = new AuditService(this.pool);
    await audit.write({
      actorId: meta.serviceCaller ?? 'unknown_caller',
      action: 'student.mfa_consume',
      entityType: 'student',
      entityId:
        payload !== null ? String(payload.canvas_user_id) : 'unknown',
      metadata: {
        outcome,
        session_origin_ip: meta.ip,
        user_agent: meta.userAgent,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }
}
