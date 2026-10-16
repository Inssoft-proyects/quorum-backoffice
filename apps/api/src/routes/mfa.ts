/**
 * M1 / MFA HTTP routes.
 *
 *   - `POST /api/v1/mfa/authenticate` — three-factor authentication
 *     (marbete code + device serial + OTP). No preHandler: the MFA
 *     flow is itself the auth. Body validation goes through Zod
 *     (`MfaAuthenticateRequest`); on success the response carries
 *     the resolved student identity + the `__Host-mfa_sid` session
 *     cookie. On any deny path the route returns the standard
 *     AppError envelope with the deny code as the wire code.
 *
 *   - `GET /api/v1/mfa/session` — small bonus route that mirrors
 *     `GET /api/v1/operator/sessions/current` for the MFA student
 *     session. Returns the current session's resolved student
 *     identity, or a 401 if no MFA session is active. The
 *     `__Host-mfa_sid` cookie is the only auth gate; no
 *     `requireSession` preHandler is needed because the session
 *     plugin already populates `req.session` from the cookie.
 *
 * Cookie policy:
 *
 *   - The session cookie is `__Host-mfa_sid` (matches the
 *     `MFA_SESSION_COOKIE_NAME` constant in the shared DTO).
 *   - The `__Host-` prefix forces Secure + Path=/ + no Domain
 *     attribute (browsers reject the cookie if any of those
 *     are violated). The integration suite asserts these
 *     attributes byte-for-byte.
 *   - The TTL is `app.config.SESSION_TTL_SECONDS` (default
 *     3600s = 1h). The M1 plan defers the operator's
 *     confirmation on the MFA-specific TTL; until that lands,
 *     reuse the operator session TTL for symmetry.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  MfaAuthenticateRequest,
  MfaAuthenticateResponse,
  MfaSessionResponse,
  MFA_SESSION_COOKIE_NAME,
} from '@quorum-backoffice/shared';
import { AppError } from '../lib/errors';
import { DenyEnvelope, ErrorEnvelope } from '../plugins/swagger';
import { isValidSessionToken } from '../lib/session-token';
import {
  MfaAuthenticateService,
  MfaAuthenticateError,
} from '../services/mfa-authenticate-service';
import { PgMfaRepo } from '../repositories/pg-mfa-repo';

function cookieFromRequest(req: FastifyRequest, name: string): string | undefined {
  const c = req.cookies[name];
  return typeof c === 'string' && c.length > 0 ? c : undefined;
}

function metaFromRequest(req: FastifyRequest): { ip: string | null; userAgent: string | null } {
  return {
    ip: req.ip ?? null,
    userAgent:
      typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  };
}

function denyCodeToHttpStatus(code: MfaAuthenticateError['code']): number {
  // dependency_fail is a 503 (the OTP service is down / unreachable).
  // Every other deny is a 401 (the supplied credentials are wrong).
  if (code === 'deny.dependency_fail') return 503;
  return 401;
}

export async function registerMfaRoutes(
  app: FastifyInstance,
  deps?: { service?: MfaAuthenticateService },
): Promise<void> {
  // Type alias for routes that attach Zod schemas. The swagger
  // plugin installs no-op validator / serializer compilers so the
  // Zod instances in `schema` are only consumed by
  // `@fastify/swagger`'s `jsonSchemaTransform` (the runtime
  // validation is done by the imperative `MfaAuthenticateRequest.parse`
  // call inside the handler — see the no-op compilers comment in
  // `apps/api/src/plugins/swagger.ts`).
  const zApp = app.withTypeProvider<ZodTypeProvider>();

  const getService = (): MfaAuthenticateService =>
    deps?.service ??
    new MfaAuthenticateService({
      pool: app.pg as unknown as import('pg').Pool,
      log: app.log,
      otp: app.otpClient,
      sessionTtlSeconds: app.config.SESSION_TTL_SECONDS,
    });

  /**
   * `POST /api/v1/mfa/authenticate`. Body: `{ marbete_code,
   * serial_number, otp }`. No preHandler: the MFA flow is
   * itself the auth. Sets the `__Host-mfa_sid` session cookie
   * on success.
   *
   * Status codes:
   *
   *   - 201 Created — authentication succeeded, session issued.
   *   - 400 Bad Request — body failed Zod validation.
   *   - 401 Unauthorized — every deny code except
   *     `deny.dependency_fail` (marbete_unknown, student_inactive,
   *     device_unknown, device_not_bound_to_student, otp_invalid).
   *   - 503 Service Unavailable — `deny.dependency_fail` (the OTP
   *     service is down / unreachable, or the DB lookup failed).
   */
  zApp.post(
    '/api/v1/mfa/authenticate',
    {
      schema: {
        // Body shape: derived from the shared Zod DTO (no
        // hand-duplicated JSON Schema).
        body: MfaAuthenticateRequest,
        // Response shapes: 201 from `MfaAuthenticateResponse`,
        // 400 from the centralized `ErrorEnvelope`, 401/503 from
        // the `DenyEnvelope` (every `deny.*` code collapses to
        // this envelope). The envelopes are inlined here as Zod
        // schemas; the swagger plugin's `transformObject` extracts
        // them into `components.schemas` and rewrites the route
        // responses to `$ref` them.
        response: {
          201: MfaAuthenticateResponse,
          400: ErrorEnvelope,
          401: DenyEnvelope,
          503: DenyEnvelope,
        },
        tags: ['mfa'],
      },
    },
    async (req, reply: FastifyReply) => {
    // Zod validation. An empty / missing field surfaces as a
    // standard `validation_error` 400 envelope (the centralized
    // error handler maps the Zod throw to the response shape).
    const body = MfaAuthenticateRequest.parse(req.body);

    const svc = getService();
    const meta = metaFromRequest(req);

    let result;
    try {
      result = await svc.authenticate(
        {
          marbeteCode: body.marbete_code,
          serialNumber: body.serial_number,
          otp: body.otp,
        },
        meta,
      );
    } catch (err) {
      if (err instanceof MfaAuthenticateError) {
        // Map the deny envelope to the standard AppError wire
        // shape. The HTTP status is derived from the deny code
        // (503 for dependency_fail, 401 for everything else).
        throw new AppError(
          err.code,
          err.message,
          denyCodeToHttpStatus(err.code),
          err.details,
        );
      }
      // Any other thrown error (should not happen — the service
      // collapses every internal error to a deny envelope) is
      // mapped to 503 dependency_fail by the centralized handler.
      throw err;
    }

    // Set the session cookie BEFORE returning the body so a
    // Set-Cookie-less response cannot be confused with a session
    // success. The `__Host-` prefix forces the browser to reject
    // the cookie if any of (Secure, Path=/, no Domain) is missing.
    reply.setCookie(MFA_SESSION_COOKIE_NAME, result.sessionToken, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: app.config.AUTH_COOKIE_SECURE,
      maxAge: app.config.SESSION_TTL_SECONDS,
    });
    reply.status(201);

    const response = MfaAuthenticateResponse.parse({
      canvas_user_id: result.canvasUserId,
      student_name: result.studentName,
      student_email: result.studentEmail,
      role: 'student',
      session_id: result.sessionId,
      expires_at: result.expiresAt.toISOString(),
    });
    return response;
  });

  /**
   * `GET /api/v1/mfa/session`. Resolves the
   * `__Host-mfa_sid` cookie to the current MFA student
   * session, or returns 401 when no session is active.
   *
   * The response shape is `MfaSessionResponse` (nullable
   * fields). A logged-out client receives a 401; a logged-in
   * client receives the resolved student identity.
   */
  zApp.get(
    '/api/v1/mfa/session',
    {
      schema: {
        response: {
          200: MfaSessionResponse,
          401: DenyEnvelope,
        },
        tags: ['mfa'],
      },
    },
    async (req) => {
    const token = cookieFromRequest(req, MFA_SESSION_COOKIE_NAME);
    if (!token || !isValidSessionToken(token)) {
      throw new AppError('unauthorized', 'no active MFA session', 401);
    }
    const repo = new PgMfaRepo(app.pg as unknown as import('pg').Pool);
    const session = await repo.findStudentSessionById(token);
    if (!session) throw new AppError('unauthorized', 'mfa session unknown', 401);
    if (session.expires_at.getTime() < Date.now()) {
      throw new AppError('unauthorized', 'mfa session expired', 401);
    }
    const response: MfaSessionResponse = {
      canvas_user_id: session.canvas_user_id,
      student_name: null, // hydrated by the client from /api/v1/mfa/authenticate
      student_email: null,
      session_id: session.id,
      expires_at: session.expires_at.toISOString(),
    };
    return response;
  });
}
