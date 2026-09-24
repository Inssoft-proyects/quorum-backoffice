/**
 * Auth REST routes (prefix /api/v1/auth).
 *
 *   POST /api/v1/auth/login/request  → request OTP email (Polish WU v6)
 *   POST /api/v1/auth/login          → exchange email + OTP for a session
 *   POST /api/v1/auth/logout         → clear session cookie
 *   GET  /api/v1/auth/me             → resolve cookie to current user
 *
 * Polish WU v6 replaces the legacy `email + password` POST /login with
 * a two-step flow. The new `request` endpoint is always idempotent
 * (returns 200 even for unknown emails) so attackers cannot enumerate
 * accounts; the audit log is the source of truth for the dispatch.
 *
 * Cookie storage is delegated to @fastify/cookie (registered in app.ts);
 * the route layer reads/writes via `reply.setCookie` / `reply.clearCookie`
 * and `req.cookies`. The AuthService owns all DB / Redis / OTP / mailer /
 * audit work.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  LoginRequestOtp,
  RequestLoginRequest,
  type MeResponse,
} from '@quorum-backoffice/shared';
import { AppError } from '../lib/errors';
import { isValidSessionToken } from '../lib/session-token';
import { AuthService } from '../services/auth-service';

function cookieFromRequest(req: FastifyRequest, name: string): string | undefined {
  const c = req.cookies[name];
  return typeof c === 'string' && c.length > 0 ? c : undefined;
}

function metaFromRequest(req: FastifyRequest): { ip: string | null; userAgent: string | null } {
  return {
    ip: req.ip ?? null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  };
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps?: { authService?: AuthService },
): Promise<void> {
  const getService = (): AuthService =>
    deps?.authService ??
    new AuthService({
      pool: app.pg as unknown as import('pg').Pool,
      log: app.log,
      redis: app.redis,
      otp: app.otpClient,
      mailer: app.mailer,
      sessionTtlSeconds: app.config.SESSION_TTL_SECONDS,
      loginMaxAttempts: app.config.AUTH_LOGIN_MAX_ATTEMPTS,
      loginWindowSeconds: app.config.AUTH_LOGIN_WINDOW_SECONDS,
      loginOtpTtlSeconds: app.config.LOGIN_OTP_TTL_SECONDS,
      loginOtpMaxAttempts: app.config.LOGIN_OTP_MAX_ATTEMPTS,
      loginOtpRequestMaxPerEmail: app.config.LOGIN_OTP_REQUEST_MAX_PER_EMAIL,
      loginOtpRequestWindowSeconds: app.config.LOGIN_OTP_REQUEST_WINDOW_SECONDS,
    });

  /**
   * Step 1 of the email+OTP login flow. Body: `{ email }`.
   *
   * Always returns 200 with `{ ok: true, retryAfterSeconds }` so a
   * malicious client cannot enumerate which addresses have accounts.
   * Disabled users get a 403; rate-limited callers get a 429.
   */
  app.post('/api/v1/auth/login/request', async (req, reply: FastifyReply) => {
    const body = RequestLoginRequest.parse(req.body);
    const svc = getService();
    const meta = metaFromRequest(req);
    const result = await svc.requestLoginOtp(body.email, meta);
    reply.header('cache-control', 'no-store');
    return { ok: true as const, retryAfterSeconds: result.retryAfterSeconds };
  });

  /**
   * Step 2 of the email+OTP login flow. Body: `{ email, otp }`.
   * The legacy `password` field is parsed but never verified.
   *
   * On success sets the session cookie and returns `{ user }`. Errors:
   *   - 400: malformed body
   *   - 401: invalid / expired / replayed OTP (code: invalid_otp or invalid_credentials)
   *   - 403: disabled user
   *   - 429: rate limit
   */
  app.post('/api/v1/auth/login', async (req, reply: FastifyReply) => {
    const body = LoginRequestOtp.parse(req.body);
    const svc = getService();
    const meta = metaFromRequest(req);
    const result = await svc.loginWithOtp(body.email, body.otp, meta);
    reply.setCookie(app.config.AUTH_COOKIE_NAME, result.sessionToken, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: app.config.AUTH_COOKIE_SECURE,
      maxAge: app.config.SESSION_TTL_SECONDS,
    });
    return { user: result.user };
  });

  app.post('/api/v1/auth/logout', async (req, reply: FastifyReply) => {
    const token = cookieFromRequest(req, app.config.AUTH_COOKIE_NAME);
    if (!token || !isValidSessionToken(token)) {
      throw new AppError('unauthorized', 'no active session', 401);
    }
    const svc = getService();
    const meta = metaFromRequest(req);
    await svc.logout(token, meta);
    reply.clearCookie(app.config.AUTH_COOKIE_NAME, {
      path: '/',
      sameSite: 'lax',
      secure: app.config.AUTH_COOKIE_SECURE,
    });
    return { ok: true as const };
  });

  app.get('/api/v1/auth/me', async (req) => {
    const token = cookieFromRequest(req, app.config.AUTH_COOKIE_NAME);
    if (!token || !isValidSessionToken(token)) {
      throw new AppError('unauthorized', 'no active session', 401);
    }
    const svc = getService();
    const me = await svc.getCurrentUser(token);
    if (!me) {
      throw new AppError('unauthorized', 'session expired or invalid', 401);
    }
    return me as MeResponse;
  });
}