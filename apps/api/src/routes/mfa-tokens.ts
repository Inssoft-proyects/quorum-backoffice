/**
 * M3 / MFA redirect-token routes.
 *
 * Two HTTP endpoints wire the SSO redirect flow between the
 * backoffice (where the student authenticates via MFA) and
 * Canvas (where the student is trying to reach):
 *
 *   - `POST /api/v1/mfa/redirect-token` (student-session cookie
 *     auth). The MFA web page calls this AFTER a successful
 *     `POST /api/v1/mfa/authenticate`. The caller has the
 *     `__Host-mfa_sid` cookie and the body is
 *     `{ next_url: string }`. The service validates the
 *     origin against `MFA_ALLOWED_REDIRECT_ORIGINS`, mints a
 *     32-byte hex token, and stores the resolved student
 *     identity + the `next_url` in Redis with a 30-second
 *     TTL. The response is `{ token, expires_in: 30 }`.
 *
 *   - `POST /api/v1/mfa/consume` (HMAC service-auth via
 *     `BACKOFFICE_SERVICE_TOKENS`, same shape as
 *     `apps/api/src/routes/access-decisions.ts`). Canvas
 *     calls this server-to-server with the token it
 *     received via the `?mfa_token=` query parameter. The
 *     service uses Redis GETDEL for atomic single-use
 *     consumption, validates the `next_url` against the
 *     same allowlist, and returns the student identity to
 *     Canvas so it can issue its own session. The deny
 *     envelope collapses every failure mode (unknown,
 *     expired, already consumed, off-allowlist) to
 *     `mfa_token_invalid` 401; the deny is logged at warn
 *     level and written to the audit log. On success, the
 *     `student.mfa_consume` audit row is written.
 *
 * Side contracts:
 *
 *   - The session lookup for `/redirect-token` uses the same
 *     `PgMfaRepo.findStudentSessionById` path the M1 GET
 *     /api/v1/mfa/session route uses, constrained to
 *     `kind='student'` so a backoffice operator session
 *     (kind='user') cannot mint an MFA redirect token.
 *   - The `MFA_ALLOWED_REDIRECT_ORIGINS` env var is a
 *     comma-separated allowlist; an empty value fails
 *     closed (every origin is rejected with 403
 *     mfa_redirect_origin_not_allowed).
 *   - The raw token is NEVER logged at INFO / WARN / ERROR
 *     level and is NEVER echoed in deny responses.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  parseServiceTokens,
  requireServiceAuth,
} from '../plugins/service-auth';
import { AppError } from '../lib/errors';
import { isValidSessionToken } from '../lib/session-token';
import { MFA_SESSION_COOKIE_NAME } from '@quorum-backoffice/shared';
import { PgMfaRepo } from '../repositories/pg-mfa-repo';
import { MfaTokenService } from '../services/mfa-token-service';
import {
  MFA_REDIRECT_TTL_SECONDS,
  parseAllowedOrigins,
} from '../services/mfa-token-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a single cookie value off the request. The MFA cookie
 * is `__Host-mfa_sid` (the cookie name is owned by the
 * shared DTO module so the M1, M2, and M3 surfaces agree).
 */
function cookieFromRequest(req: FastifyRequest, name: string): string | undefined {
  const c = req.cookies[name];
  return typeof c === 'string' && c.length > 0 ? c : undefined;
}

function metaFromRequest(req: FastifyRequest): {
  ip: string | null;
  userAgent: string | null;
  serviceCaller: string | null;
} {
  return {
    ip: req.ip ?? null,
    userAgent:
      typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    serviceCaller:
      typeof (req as unknown as { serviceCaller?: string }).serviceCaller === 'string'
        ? (req as unknown as { serviceCaller: string }).serviceCaller
        : null,
  };
}

// ---------------------------------------------------------------------------
// Zod body schemas
// ---------------------------------------------------------------------------

/**
 * `POST /api/v1/mfa/redirect-token` body. `next_url` is a
 * non-empty string; the route layer does NOT pre-validate the
 * URL format with Zod (the service's `extractOrigin` throws
 * on a parse failure, which the route maps to 400). The
 * 1..2048 byte bound matches the longest realistic Canvas
 * URL; anything beyond that is treated as a client bug.
 */
const MfaRedirectTokenRequest = z.object({
  next_url: z.string().min(1).max(2048),
});

/**
 * `POST /api/v1/mfa/consume` body. The token shape is
 * constrained to the documented 64-char lowercase hex
 * (32 random bytes hex-encoded) so a malformed caller gets
 * 400 validation_error rather than a 401 deny envelope
 * (which would let the caller probe the token format).
 */
const MfaConsumeRequest = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/, 'token must be 64 lowercase hex chars'),
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerMfaTokenRoutes(app: FastifyInstance): Promise<void> {
  // The raw-body capture plugin is registered by
  // `registerAccessDecisionsRoutes` (see apps/api/src/routes/access-decisions.ts).
  // Because the plugin is wrapped in `fastify-plugin`, the
  // content-type parser attaches GLOBALLY to the app, so any
  // subsequent route registration that needs `req.rawBody`
  // (e.g. the HMAC preHandler below) inherits it without a
  // second `addContentTypeParser` call (which would throw
  // "Content type parser 'application/json' already present").
  //
  // We rely on the registration order in `app.ts`:
  //   `registerAccessDecisionsRoutes(...)` runs first, so the
  //   content-type parser is in place by the time the consume
  //   route's preHandler consults `req.rawBody`.

  // The HMAC preHandler is built once per app instance from
  // the app config. An empty registry fails closed (every
  // call is rejected with deny.idp_untrusted) so a
  // misconfigured deploy that leaves BACKOFFICE_SERVICE_TOKENS
  // empty cannot silently allow traffic.
  const registry = parseServiceTokens({
    BACKOFFICE_SERVICE_TOKENS: app.config.BACKOFFICE_SERVICE_TOKENS,
  });
  const skewSeconds = app.config.BACKOFFICE_SERVICE_HMAC_SKEW_SECONDS;
  const consumePreHandler = requireServiceAuth({ registry, skewSeconds });

  // The service is built per-request so the `redis` and `pool`
  // resolutions pick up any per-app overrides (test fakes,
  // dev-only swaps). Centralizing the construction in a
  // single getter keeps the route handlers free of plumbing.
  const getService = (): MfaTokenService =>
    new MfaTokenService({
      redis: app.redis,
      pool: app.pg as unknown as import('pg').Pool,
      log: app.log,
      allowedOrigins: parseAllowedOrigins(app.config.MFA_ALLOWED_REDIRECT_ORIGINS),
    });

  /**
   * `POST /api/v1/mfa/redirect-token`.
   *
   * Status codes:
   *
   *   - 200 OK — token issued; body is `{ token, expires_in: 30 }`.
   *   - 400 Bad Request — body failed Zod validation OR
   *     `next_url` is not a parseable URL.
   *   - 401 Unauthorized — no MFA session cookie (unauthorized)
   *     or the session is a non-student kind (mfa_session_kind_invalid).
   *   - 403 Forbidden — `next_url` origin is not in
   *     `MFA_ALLOWED_REDIRECT_ORIGINS`.
   */
  app.post('/api/v1/mfa/redirect-token', async (req, reply) => {
    const body = MfaRedirectTokenRequest.parse(req.body);

    // Resolve the student session. The cookie name is the
    // shared DTO constant; the lookup constrains to
    // kind='student' so a backoffice operator session
    // (kind='user') cannot mint a redirect token. The
    // kind mismatch is surfaced as a distinct wire code
    // (mfa_session_kind_invalid) so an operator can pivot
    // a misrouted request in the audit log without joining
    // on the sessions table.
    const token = cookieFromRequest(req, MFA_SESSION_COOKIE_NAME);
    if (!token || !isValidSessionToken(token)) {
      throw new AppError('unauthorized', 'no active MFA session', 401);
    }
    const pool = app.pg as unknown as import('pg').Pool;
    const kindRow = await pool.query<{ kind: 'user' | 'student' }>(
      `SELECT kind FROM sessions WHERE id = $1`,
      [token],
    );
    if (kindRow.rows.length === 0) {
      throw new AppError('unauthorized', 'mfa session unknown', 401);
    }
    if (kindRow.rows[0]?.kind !== 'student') {
      throw new AppError(
        'mfa_session_kind_invalid',
        'mfa redirect-token requires a student session',
        401,
      );
    }
    const repo = new PgMfaRepo(pool);
    const session = await repo.findStudentSessionById(token);
    if (!session) {
      throw new AppError('unauthorized', 'mfa session unknown', 401);
    }
    if (session.expires_at.getTime() < Date.now()) {
      throw new AppError('unauthorized', 'mfa session expired', 401);
    }

    // Hydrate the student record so the redirect-token
    // payload carries the denormalized name + email Canvas
    // needs to mint its own session. The student id is the
    // canvas_user_id (the wire identifier the M1 endpoint
    // returned); we resolve it via students_cache.canvas_user_id
    // via a small query (no shared helper yet — the M1
    // service keeps this denormalized on the session row
    // by inserting the canvas_user_id directly).
    const studentRow = await (
      app.pg as unknown as import('pg').Pool
    ).query<{ full_name: string; email: string }>(
      `SELECT full_name, email
         FROM students_cache
        WHERE canvas_user_id = $1`,
      [session.canvas_user_id],
    );
    const student = studentRow.rows[0];
    if (!student) {
      // The student row vanished between the M1
      // authentication and the M3 redirect. Fail closed:
      // we cannot safely mint a token without the
      // denormalized name / email.
      throw new AppError('unauthorized', 'student record is missing', 401);
    }

    const svc = getService();
    // The service throws AppError on every deny path; the
    // centralized error handler maps it to the documented
    // envelope. We do NOT need a try/catch here.
    const result = await svc.issueToken({
      canvasUserId: session.canvas_user_id,
      studentName: student.full_name,
      studentEmail: student.email,
      nextUrl: body.next_url,
    });
    reply.status(200);
    return {
      token: result.token,
      expires_in: result.expiresIn,
    };
  });

  /**
   * `POST /api/v1/mfa/consume`. HMAC service-auth enforced by
   * the preHandler. Body is `{ token: <64 hex> }`.
   *
   * Status codes:
   *
   *   - 200 OK — student identity returned; token deleted.
   *   - 400 Bad Request — body failed Zod validation.
   *   - 401 Unauthorized — every documented deny path
   *     (transport auth fail, unknown/expired/consumed token,
   *     off-allowlist next_url, malformed payload). The wire
   *     code is `mfa_token_invalid` for the token-related
   *     denies and `deny.idp_untrusted` for the transport
   *     auth fails.
   */
  app.post(
    '/api/v1/mfa/consume',
    { preHandler: consumePreHandler },
    async (req, reply) => {
      const body = MfaConsumeRequest.parse(req.body);
      const svc = getService();
      const meta = metaFromRequest(req);
      // The service throws AppError on every deny path
      // (mfa_token_invalid for token-related denies,
      // mfa_redirect_origin_not_allowed surfaces as
      // mfa_token_invalid at the wire boundary). The HMAC
      // preHandler throws AppError('deny.idp_untrusted', ...)
      // on every transport auth failure. Both are mapped to
      // the wire envelope by the centralized error handler.
      const result = await svc.consumeToken(body.token, meta);
      reply.status(200);
      return {
        canvas_user_id: result.canvasUserId,
        student_name: result.studentName,
        student_email: result.studentEmail,
        role: result.role,
        next_url: result.nextUrl,
      };
    },
  );
}

// Re-export the TTL constant so tests that need to pin the
// value at the route boundary (vs. the service boundary) can
// import it from one place.
export { MFA_REDIRECT_TTL_SECONDS };
