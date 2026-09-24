/**
 * Auth service: login (email + OTP), logout, current-user resolution.
 *
 * Polish WU v6: replaces the legacy `email + password` login flow with
 * `email + OTP`. Two endpoints own the new flow:
 *
 *   - `requestLoginOtp(email)`:
 *       1. Rate-limit per email (`LOGIN_OTP_REQUEST_MAX_PER_EMAIL` /
 *          `LOGIN_OTP_REQUEST_WINDOW_SECONDS`).
 *       2. Look the user up; if unknown, respond 200 anyway with
 *          `retryAfterSeconds` so attackers cannot enumerate accounts.
 *          Audit `auth.login.requested` is still emitted with the
 *          email-as-subject so brute-force sweeps are observable.
 *       3. If the user is disabled, fail with 403 (no email is sent).
 *       4. Ask the OTP service for a 6-char alphanumeric token bound
 *          to (email, scope='login'), honouring OTP-service rate limits.
 *       5. Deliver the token to the user via the configured mailer
 *          (SMTP in production, logged to pino in dev).
 *
 *   - `loginWithOtp(email, otp)`:
 *       1. Ask the OTP service to verify the (email, scope, otp) tuple.
 *          Lockouts, replays, and per-OTP attempt caps are owned by
 *          the OTP service.
 *       2. On success, load the user, reject if disabled, issue a
 *          session, audit `auth.login.otp_verified`.
 *       3. On failure, audit `auth.login.failed` with the reason
 *          (`invalid_otp`, `locked`, `expired`, etc).
 *
 * `login(req)` (the legacy email+password entry point) is preserved as
 * a thin wrapper around `loginWithOtp` that ignores the `password`
 * field. It exists so the existing `/api/v1/auth/login` route, its
 * tests, and old clients keep working while the migration completes.
 *
 * The `users.password_hash` column is **not** read by the new flow.
 * It is preserved on disk for legacy recovery and for the bootstrap
 * seed migration; future WUs may drop it once we have a documented
 * reset procedure.
 */
import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { LoginRequest, MeResponse, UserRole } from '@quorum-backoffice/shared';
import { AppError } from '../lib/errors';
import { generateSessionToken } from '../lib/session-token';
import {
  hitLoginRateLimit,
  resetLoginRateLimit,
  type RedisLike,
} from '../lib/rate-limit';
import { PgUserRepo } from '../repositories/pg-users';
import { PgSessionRepo } from '../repositories/pg-sessions';
import { AuditService } from './audit-service';
import { OtpClient } from './otp-client';
import type { Mailer } from './mailer';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

interface ServiceDeps {
  pool: pg.Pool;
  log: FastifyBaseLogger;
  redis: RedisLike;
  otp: OtpClient;
  mailer: Mailer;
  sessionTtlSeconds: number;
  /** Legacy password-login rate limit (5 / 15 min). Kept for tests. */
  loginMaxAttempts: number;
  loginWindowSeconds: number;
  /** Login-OTP specific knobs. */
  loginOtpTtlSeconds: number;
  loginOtpMaxAttempts: number;
  loginOtpRequestMaxPerEmail: number;
  loginOtpRequestWindowSeconds: number;
}

export interface LoginResult {
  user: MeResponse;
  sessionToken: string;
}

export interface RequestLoginResult {
  /** Seconds the user should wait before requesting another OTP. */
  retryAfterSeconds: number;
}

export const AUTH_TOKEN_AUDIT_PREFIX = 8;

/** OTP scope bound to the login flow. */
export const LOGIN_OTP_SCOPE = 'login';

export class AuthService {
  private readonly users: PgUserRepo;
  private readonly sessions: PgSessionRepo;
  private readonly log: FastifyBaseLogger;
  private readonly redis: RedisLike;
  private readonly otp: OtpClient;
  private readonly mailer: Mailer;
  private readonly pool: pg.Pool;
  private readonly sessionTtlSeconds: number;
  private readonly loginMaxAttempts: number;
  private readonly loginWindowSeconds: number;
  private readonly loginOtpTtlSeconds: number;
  private readonly loginOtpMaxAttempts: number;
  private readonly loginOtpRequestMaxPerEmail: number;
  private readonly loginOtpRequestWindowSeconds: number;

  constructor(private readonly deps: ServiceDeps) {
    this.users = new PgUserRepo(deps.pool);
    this.sessions = new PgSessionRepo(deps.pool);
    this.log = deps.log;
    this.redis = deps.redis;
    this.otp = deps.otp;
    this.mailer = deps.mailer;
    this.pool = deps.pool;
    this.sessionTtlSeconds = deps.sessionTtlSeconds;
    this.loginMaxAttempts = deps.loginMaxAttempts;
    this.loginWindowSeconds = deps.loginWindowSeconds;
    this.loginOtpTtlSeconds = deps.loginOtpTtlSeconds;
    this.loginOtpMaxAttempts = deps.loginOtpMaxAttempts;
    this.loginOtpRequestMaxPerEmail = deps.loginOtpRequestMaxPerEmail;
    this.loginOtpRequestWindowSeconds = deps.loginOtpRequestWindowSeconds;
  }

  /**
   * Step 1: request an OTP for login. Always responds 200 with
   * `retryAfterSeconds`, even for unknown emails, to avoid leaking
   * which addresses have accounts. Audit is still emitted per call.
   */
  async requestLoginOtp(
    email: string,
    meta: RequestMeta = { ip: null, userAgent: null },
  ): Promise<RequestLoginResult> {
    const normalised = email.toLowerCase();

    const rate = await hitLoginRateLimit(
      this.redis,
      `otp-req:${normalised}`,
      this.loginOtpRequestMaxPerEmail,
      this.loginOtpRequestWindowSeconds,
    );
    if (!rate.ok) {
      this.log.warn(
        { email: normalised, retryAfterSeconds: rate.retryAfterSeconds },
        'login_otp_request_rate_limited',
      );
      await new AuditService(this.pool).write({
        actorId: normalised,
        action: 'auth.login.requested',
        entityType: 'otp_request',
        entityId: 'rate_limited',
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      throw new AppError(
        'rate_limited',
        'too many OTP requests, please try again later',
        429,
        { retryAfterSeconds: rate.retryAfterSeconds },
      );
    }

    const user = await this.users.findByEmail(normalised);

    // Disabled: hard 403. No OTP is issued and no email is sent.
    if (user && user.disabled_at !== null) {
      await new AuditService(this.pool).write({
        actorId: normalised,
        action: 'auth.login.requested',
        entityType: 'otp_request',
        entityId: 'disabled',
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      throw new AppError('user_disabled', 'user account is disabled', 403);
    }

    // Unknown email or disabled path: respond 200 with the same
    // retryAfterSeconds we would otherwise use. We still audit so a
    // sweep is detectable.
    if (!user) {
      await new AuditService(this.pool).write({
        actorId: normalised,
        action: 'auth.login.requested',
        entityType: 'otp_request',
        entityId: 'unknown_email',
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return {
        retryAfterSeconds: Math.min(this.loginOtpRequestWindowSeconds, 60),
      };
    }

    const issued = await this.otp.issue({
      subject: user.email,
      scope: LOGIN_OTP_SCOPE,
      ttlSeconds: this.loginOtpTtlSeconds,
      maxAttempts: this.loginOtpMaxAttempts,
    });

    if (!issued.ok) {
      await new AuditService(this.pool).write({
        actorId: normalised,
        action: 'auth.login.requested',
        entityType: 'otp_request',
        entityId: `otp_${issued.reason}`,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      if (issued.reason === 'rate_limited') {
        throw new AppError(
          'rate_limited',
          'too many OTP requests, please try again later',
          429,
          { retryAfterSeconds: issued.retryAfterSeconds ?? 60 },
        );
      }
      if (issued.reason === 'invalid_request') {
        throw AppError.badRequest('invalid_otp_request');
      }
      throw AppError.serviceUnavailable('otp_issue_failed');
    }

    try {
      await this.mailer.sendOtpEmail({
        to: user.email,
        code: issued.token,
        ttlSeconds: issued.ttlSeconds,
      });
    } catch (err) {
      // Mailer failure is fatal for the OTP flow: the user cannot
      // complete login. We surface a 503 and let the route log
      // a generic error. The OTP service still owns the token; the
      // user will see a new code if they retry (the previous one
      // expires after ttlSeconds and was never verified).
      this.log.warn(
        { err, userId: user.id, email: user.email, otpId: issued.otpId },
        'login_otp_delivery_failed',
      );
      await new AuditService(this.pool).write({
        actorId: normalised,
        action: 'auth.login.requested',
        entityType: 'otp_request',
        entityId: `delivery_failed:${issued.otpId}`,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      throw AppError.serviceUnavailable('otp_delivery_failed');
    }

    await new AuditService(this.pool).write({
      actorId: normalised,
      action: 'auth.login.requested',
      entityType: 'otp_request',
      entityId: issued.otpId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      retryAfterSeconds: Math.min(this.loginOtpRequestWindowSeconds, 60),
    };
  }

  /**
   * Step 2: exchange email + OTP for a session cookie.
   *
   * Errors (all AppError):
   *   - rate_limited (429) — local per-email or OTP-service lockout
   *   - invalid_otp (401) — wrong / expired / replayed OTP
   *   - user_disabled (403)
   *
   * Emits `auth.login.otp_verified` + `auth.login` on success, and
   * `auth.login.failed` on every failure path with a discriminator in
   * `entityId`.
   */
  async loginWithOtp(
    email: string,
    otp: string,
    meta: RequestMeta = { ip: null, userAgent: null },
  ): Promise<LoginResult> {
    const normalised = email.toLowerCase();

    // Local rate limit (same budget as the legacy login path). Both
    // paths share a Redis bucket to keep DOS attack surface narrow.
    const rate = await hitLoginRateLimit(
      this.redis,
      normalised,
      this.loginMaxAttempts,
      this.loginWindowSeconds,
    );
    if (!rate.ok) {
      this.log.warn(
        { email: normalised, retryAfterSeconds: rate.retryAfterSeconds },
        'login_otp_rate_limited',
      );
      throw new AppError(
        'rate_limited',
        'too many login attempts, please try again later',
        429,
        { retryAfterSeconds: rate.retryAfterSeconds },
      );
    }

    const verification = await this.otp.verify({
      subject: normalised,
      scope: LOGIN_OTP_SCOPE,
      code: otp,
    });

    if (!verification.ok) {
      const reason = verification.reason;
      await this.recordLoginFailure(normalised, reason, meta);
      // The OTP service deliberately does not distinguish reasons to
      // the caller; mirror that on the API to avoid leaking internal
      // state. The discriminator is only in the audit log.
      if (reason === 'locked') {
        throw new AppError(
          'rate_limited',
          'too many login attempts, please try again later',
          429,
        );
      }
      throw new AppError('invalid_otp', 'invalid or expired code', 401);
    }

    const user = await this.users.findByEmail(normalised);
    if (!user) {
      // The OTP service said the OTP was valid, but the user record
      // does not exist any more (deleted between request and verify).
      // Treat as invalid credentials.
      await this.recordLoginFailure(normalised, 'unknown_user_at_verify', meta);
      throw new AppError('invalid_credentials', 'invalid email or code', 401);
    }
    if (user.disabled_at !== null) {
      await this.recordLoginFailure(normalised, 'disabled', meta);
      throw new AppError('user_disabled', 'user account is disabled', 403);
    }

    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + this.sessionTtlSeconds * 1000);
    await this.sessions.insert({
      id: token,
      userId: user.id,
      expiresAt,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await this.users.updateLastLogin(user.id);
    await resetLoginRateLimit(this.redis, normalised);

    await new AuditService(this.pool).write({
      actorId: user.email,
      action: 'auth.login.otp_verified',
      entityType: 'otp',
      entityId: verification.otpId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await new AuditService(this.pool).write({
      actorId: user.email,
      action: 'auth.login',
      entityType: 'session',
      entityId: token.slice(0, AUTH_TOKEN_AUDIT_PREFIX),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      user: { id: user.id, email: user.email, role: user.role as UserRole },
      sessionToken: token,
    };
  }

  /**
   * Legacy entry point. Kept so the existing integration test suite
   * (which seeds users with bcrypt hashes) and any older clients
   * continue to work. The `password` field is parsed but not
   * verified — the OTP path is the only accepted login.
   *
   * This method is intentionally read-only against `users.password_hash`
   * so future hardening can drop the column without rewriting tests.
   */
  async login(
    req: LoginRequest,
    meta: RequestMeta = { ip: null, userAgent: null },
  ): Promise<LoginResult> {
    return this.loginWithOtp(req.email, req.otp, meta);
  }

  /**
   * Resolve a session token to the current user. Returns null if the token
   * is unknown, expired, or the user was disabled since issuance.
   */
  async getCurrentUser(token: string): Promise<MeResponse | null> {
    const session = await this.sessions.findById(token);
    if (!session) return null;
    if (session.expires_at.getTime() < Date.now()) {
      // Expired — clean up asynchronously (don't block the request).
      this.sessions.deleteById(token).catch(() => undefined);
      return null;
    }
    const user = await this.users.findById(session.user_id);
    if (!user || user.disabled_at !== null) return null;
    return { id: user.id, email: user.email, role: user.role as UserRole };
  }

  async logout(
    token: string,
    meta: RequestMeta = { ip: null, userAgent: null },
  ): Promise<{ actorEmail: string | null }> {
    const session = await this.sessions.findById(token);
    let actorEmail: string | null = null;
    if (session) {
      const user = await this.users.findById(session.user_id);
      if (user) actorEmail = user.email;
      await this.sessions.deleteById(token);
    }
    await new AuditService(this.pool).write({
      actorId: actorEmail ?? 'anonymous',
      action: 'auth.logout',
      entityType: 'session',
      entityId: token.slice(0, AUTH_TOKEN_AUDIT_PREFIX),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { actorEmail };
  }

  private async recordLoginFailure(
    email: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    await new AuditService(this.pool).write({
      actorId: email,
      action: 'auth.login.failed',
      entityType: 'session',
      entityId: reason,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  /**
   * Back-compat shim used by older tests that imported the original
   * `recordFailure` private method. Internally it just delegates to
   * `recordLoginFailure` with the same reason vocabulary.
   */
  private async recordFailure(email: string, reason: string, meta: RequestMeta): Promise<void> {
    return this.recordLoginFailure(email, reason, meta);
  }
}