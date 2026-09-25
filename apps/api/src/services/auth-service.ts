/**
 * Auth service: single-step username + pre-issued OTP login.
 *
 * New flow (replaces the prior email+request-code flow):
 *
 *   `loginWithOtp(username, otp)`:
 *     1. Rate-limit per username (`AUTH_LOGIN_MAX_ATTEMPTS` /
 *        `AUTH_LOGIN_WINDOW_SECONDS`).
 *     2. Look the user up by canonical username (case-insensitive).
 *        - Unknown username: surface a stable `invalid_credentials`
 *          so attackers cannot enumerate which usernames have
 *          accounts.
 *        - Account exists but has no `username` assigned: surface a
 *          stable `user_unmapped` so the missing production mapping
 *          is observable in the audit log without leaking the
 *          existence of the row.
 *        - Account disabled: surface 403 user_disabled.
 *     3. Ask quorum-otp to verify the pre-issued (subject, scope)
 *        OTP. The subject bound on the wire is the canonical
 *        username (`lower(trim(username))`), NOT the email — this is
 *        the contract the provider HMAC-verifies.
 *     4. On success, issue a session cookie, audit
 *        `auth.login.otp_verified`, then `auth.login`.
 *     5. On failure, audit `auth.login.failed` with a discriminator
 *        (`invalid_otp`, `locked`, etc.) in `entityId`.
 *
 * BackOffice no longer issues OTPs itself and no longer reads
 * `users.password_hash` at login. The legacy `login(LoginRequest)`
 * wrapper was removed because its semantics (password field, email
 * field) no longer match the wire contract; the only HTTP entry is
 * `POST /api/v1/auth/login { username, otp }`.
 *
 * Provider 401/403 = dependency auth/service-unavailable; provider
 * 409 = invalid user OTP.
 */
import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { MeResponse, UserRole } from '@quorum-backoffice/shared';
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

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

interface ServiceDeps {
  pool: pg.Pool;
  log: FastifyBaseLogger;
  redis: RedisLike;
  otp: OtpClient;
  sessionTtlSeconds: number;
  /** Legacy password-login rate limit (5 / 15 min). Reused for username login. */
  loginMaxAttempts: number;
  loginWindowSeconds: number;
}

export interface LoginResult {
  user: MeResponse;
  sessionToken: string;
}

export const AUTH_TOKEN_AUDIT_PREFIX = 8;

/** OTP scope bound to the username-login flow. quorum-otp issues
 *  codes bound to (`<username>`, "login"). */
export const LOGIN_OTP_SCOPE = 'login';

/**
 * Normalize a BackOffice username to the canonical wire form used as
 * the `subject` in the quorum-otp API call. Trimmed and lower-cased
 * so that `admin`/`Admin`/`ADMIN` all bind to the same OTP issuance.
 */
export function canonicaliseUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export class AuthService {
  private readonly users: PgUserRepo;
  private readonly sessions: PgSessionRepo;
  private readonly log: FastifyBaseLogger;
  private readonly redis: RedisLike;
  private readonly otp: OtpClient;
  private readonly pool: pg.Pool;
  private readonly sessionTtlSeconds: number;
  private readonly loginMaxAttempts: number;
  private readonly loginWindowSeconds: number;

  constructor(private readonly deps: ServiceDeps) {
    this.users = new PgUserRepo(deps.pool);
    this.sessions = new PgSessionRepo(deps.pool);
    this.log = deps.log;
    this.redis = deps.redis;
    this.otp = deps.otp;
    this.pool = deps.pool;
    this.sessionTtlSeconds = deps.sessionTtlSeconds;
    this.loginMaxAttempts = deps.loginMaxAttempts;
    this.loginWindowSeconds = deps.loginWindowSeconds;
  }

  /**
   * Single-step login: exchange (username, otp) for a session cookie.
   *
   * Errors (all AppError):
   *   - rate_limited (429)  — local per-username or OTP-service lockout
   *   - invalid_credentials (401) — unknown username OR OTP rejected
   *   - user_disabled (403) — account disabled
   *   - user_unmapped (403) — account exists but `users.username IS NULL`
   *   - service_unavailable (503) — quorum-otp auth failure / 5xx / timeout
   *
   * Emits `auth.login.otp_verified` + `auth.login` on success and
   * `auth.login.failed` on every failure path with a discriminator
   * (`unknown_user`, `unmapped_user`, `invalid_otp`, `locked`,
   * `disabled`, `service_unavailable`) in `entityId`. The username is
   * recorded in `actorId` so brute-force sweeps on a single username
   * are observable in the audit log.
   */
  async loginWithOtp(
    rawUsername: string,
    otp: string,
    meta: RequestMeta = { ip: null, userAgent: null },
  ): Promise<LoginResult> {
    const canonical = canonicaliseUsername(rawUsername);
    if (!canonical) {
      throw new AppError('invalid_credentials', 'invalid username or code', 401);
    }

    // Local per-username rate limit. Keyed by canonical username so a
    // sweep across `admin`/`Admin` shares a budget.
    const rate = await hitLoginRateLimit(
      this.redis,
      canonical,
      this.loginMaxAttempts,
      this.loginWindowSeconds,
    );
    if (!rate.ok) {
      this.log.warn(
        { username: canonical, retryAfterSeconds: rate.retryAfterSeconds },
        'login_rate_limited',
      );
      throw new AppError(
        'rate_limited',
        'too many login attempts, please try again later',
        429,
        { retryAfterSeconds: rate.retryAfterSeconds },
      );
    }

    // We deliberately look up the local user BEFORE the OTP verify so
    // we can:
    //   - refuse disabled accounts before exposing the OTP path;
    //   - return a distinct `user_unmapped` when the row exists but
    //     has no username yet (audit-friendly);
    //   - log a discriminator against the username for every outcome.
    const user = await this.users.findByUsername(canonical);
    if (!user) {
      await this.recordLoginFailure(canonical, 'unknown_user', meta);
      // Same shape as invalid_otp so attackers cannot enumerate.
      throw new AppError('invalid_credentials', 'invalid username or code', 401);
    }
    if (user.disabled_at !== null) {
      await this.recordLoginFailure(canonical, 'disabled', meta);
      throw new AppError('user_disabled', 'user account is disabled', 403);
    }
    if (user.username === null) {
      // Defensive: findByUsername only matches non-null rows, but if
      // the row mutated between SELECTs we surface a stable error.
      await this.recordLoginFailure(canonical, 'unmapped_user', meta);
      throw new AppError(
        'user_unmapped',
        'username not assigned for this account',
        403,
      );
    }

    // Verify the pre-issued OTP against quorum-otp. The provider HMAC
    // requires the subject to be the canonical username — exactly
    // the value the issuer bound during the upstream issuance flow.
    let verification;
    try {
      verification = await this.otp.verify({
        subject: user.username,
        scope: LOGIN_OTP_SCOPE,
        code: otp,
      });
    } catch (err) {
      if (err instanceof AppError) {
        await this.recordLoginFailure(canonical, 'service_unavailable', meta);
        throw err;
      }
      throw AppError.serviceUnavailable('otp_dependent_failure');
    }

    if (!verification.ok) {
      const reason = verification.reason;
      await this.recordLoginFailure(canonical, reason, meta);
      if (reason === 'locked') {
        throw new AppError(
          'rate_limited',
          'too many login attempts, please try again later',
          429,
        );
      }
      // 'invalid' | 'expired' | 'rate_limited' | 'unknown' all collapse
      // to a single invalid-credentials response so we don't leak
      // provider-internal reasons.
      throw new AppError('invalid_credentials', 'invalid username or code', 401);
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
    await resetLoginRateLimit(this.redis, canonical);

    await new AuditService(this.pool).write({
      actorId: user.username ?? canonical,
      action: 'auth.login.otp_verified',
      entityType: 'otp',
      entityId: verification.otpId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await new AuditService(this.pool).write({
      actorId: user.username ?? canonical,
      action: 'auth.login',
      entityType: 'session',
      entityId: token.slice(0, AUTH_TOKEN_AUDIT_PREFIX),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    // MeResponse keeps `email` for existing UI/audit consumers.
    return {
      user: { id: user.id, email: user.email, role: user.role as UserRole },
      sessionToken: token,
    };
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
    username: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    await new AuditService(this.pool).write({
      actorId: username,
      action: 'auth.login.failed',
      entityType: 'session',
      entityId: reason,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }
}
