/**
 * Auth service: login, logout, current-user resolution.
 *
 * Owns:
 *   - bcrypt password verification (cost 12, configurable for tests)
 *   - Redis-backed login rate limit (5 attempts / 15 min default)
 *   - session token issuance + storage
 *   - audit emission for `auth.login`, `auth.logout`, `auth.failed`
 *
 * The session token is opaque (32 random bytes, base64url). It is the
 * primary key of the `sessions` table and is carried by the cookie as-is.
 * Only the first 8 chars are ever persisted in audit_log to avoid storing
 * a long-lived credential.
 */
import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { LoginRequest, MeResponse, UserRole } from '@quorum-backoffice/shared';
import { AppError } from '../lib/errors';
import { verifyPassword } from '../lib/password';
import { generateSessionToken } from '../lib/session-token';
import { hitLoginRateLimit, resetLoginRateLimit, type RedisLike } from '../lib/rate-limit';
import { PgUserRepo } from '../repositories/pg-users';
import { PgSessionRepo } from '../repositories/pg-sessions';
import { AuditService } from './audit-service';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

interface ServiceDeps {
  pool: pg.Pool;
  log: FastifyBaseLogger;
  redis: RedisLike;
  sessionTtlSeconds: number;
  loginMaxAttempts: number;
  loginWindowSeconds: number;
}

export interface LoginResult {
  user: MeResponse;
  sessionToken: string;
}

export const AUTH_TOKEN_AUDIT_PREFIX = 8;

export class AuthService {
  private readonly users: PgUserRepo;
  private readonly sessions: PgSessionRepo;
  private readonly log: FastifyBaseLogger;
  private readonly redis: RedisLike;
  private readonly sessionTtlSeconds: number;
  private readonly loginMaxAttempts: number;
  private readonly loginWindowSeconds: number;
  private readonly pool: pg.Pool;

  constructor(private readonly deps: ServiceDeps) {
    this.users = new PgUserRepo(deps.pool);
    this.sessions = new PgSessionRepo(deps.pool);
    this.log = deps.log;
    this.redis = deps.redis;
    this.sessionTtlSeconds = deps.sessionTtlSeconds;
    this.loginMaxAttempts = deps.loginMaxAttempts;
    this.loginWindowSeconds = deps.loginWindowSeconds;
    this.pool = deps.pool;
  }

  /**
   * Verify email + password. Throws:
   *   - AppError('rate_limited', 429) when over the attempt budget
   *   - AppError('invalid_credentials', 401) on wrong password OR unknown user
   *   - AppError('user_disabled', 403) on disabled_at != null
   *
   * Emits audit `auth.failed` on credential failures and `auth.login` on
   * success.
   */
  async login(req: LoginRequest, meta: RequestMeta = { ip: null, userAgent: null }): Promise<LoginResult> {
    const email = req.email.toLowerCase();

    // Rate limit check (before we touch the DB).
    const rate = await hitLoginRateLimit(
      this.redis,
      email,
      this.loginMaxAttempts,
      this.loginWindowSeconds,
    );
    if (!rate.ok) {
      this.log.warn(
        { email, retryAfterSeconds: rate.retryAfterSeconds },
        'login_rate_limited',
      );
      throw new AppError(
        'rate_limited',
        'too many login attempts, please try again later',
        429,
        { retryAfterSeconds: rate.retryAfterSeconds },
      );
    }

    const user = await this.users.findByEmail(email);
    if (!user) {
      // For test simplicity we accept the slight timing leak between
      // unknown-user and wrong-password paths. Production should consider
      // bcrypt-verify against a precomputed dummy hash to equalize the path.
      await this.recordFailure(email, 'unknown_user', meta);
      throw new AppError('invalid_credentials', 'invalid email or password', 401);
    }
    if (user.disabled_at !== null) {
      await this.recordFailure(email, 'disabled', meta);
      throw new AppError('user_disabled', 'user account is disabled', 403);
    }
    const ok = await verifyPassword(req.password, user.password_hash);
    if (!ok) {
      await this.recordFailure(email, 'wrong_password', meta);
      throw new AppError('invalid_credentials', 'invalid email or password', 401);
    }

    // Issue a session.
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

    // Successful login clears the rate-limit counter for that email.
    await resetLoginRateLimit(this.redis, email);

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

  private async recordFailure(email: string, reason: string, meta: RequestMeta): Promise<void> {
    await new AuditService(this.pool).write({
      actorId: email,
      action: 'auth.failed',
      entityType: 'session',
      entityId: reason,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }
}
