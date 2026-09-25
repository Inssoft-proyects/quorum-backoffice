/**
 * Auth REST routes (prefix /api/v1/auth).
 *
 *   POST /api/v1/auth/login   → exchange username + OTP for a session cookie
 *   POST /api/v1/auth/logout  → clear session cookie
 *   GET  /api/v1/auth/me      → resolve cookie to current user
 *
 * The login API exposes a single one-step flow. The user arrives with
 * a pre-issued OTP (delivered by the broader quorum ecosystem, not
 * by the BackOffice); we verify it against quorum-otp under the HMAC
 * service identity `quorum-backoffice` and exchange it for a session
 * cookie. Username lookup uses the canonical lower-case form so the
 * `subject` bound on the wire matches what the issuer encoded.
 *
 * Cookie storage is delegated to @fastify/cookie (registered in app.ts);
 * the route layer reads/writes via `reply.setCookie` / `reply.clearCookie`
 * and `req.cookies`. The AuthService owns all DB / Redis / OTP /
 * audit work.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  LoginRequestOtp,
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
      sessionTtlSeconds: app.config.SESSION_TTL_SECONDS,
      loginMaxAttempts: app.config.AUTH_LOGIN_MAX_ATTEMPTS,
      loginWindowSeconds: app.config.AUTH_LOGIN_WINDOW_SECONDS,
    });

  /**
   * Single-step username + OTP login. Body: `{ username, otp }`.
   *
   * On success: sets the session cookie and returns `{ user }`.
   * Errors:
   *   - 400: malformed body
   *   - 401: invalid / expired / replayed OTP, or unknown username
   *   - 403: disabled user / user_unmapped
   *   - 429: rate-limited
   *   - 503: dependency failure (quorum-otp HMAC or provider 5xx)
   */
  app.post('/api/v1/auth/login', async (req, reply: FastifyReply) => {
    const body = LoginRequestOtp.parse(req.body);
    const svc = getService();
    const meta = metaFromRequest(req);
    const result = await svc.loginWithOtp(body.username, body.otp, meta);
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
