/**
 * OtpGrantService: backoffice-local cache of recently-verified OTPs.
 *
 * When an actor successfully verifies a fresh single-use OTP against
 * quorum-otp for a grant-eligible scope (today: `marbete.create`,
 * `marbete.update`, `marbete.delete`, `marbete.bulk_create`), this
 * service records a grant row with a TTL window. Further destructive
 * operations within the window read the grant and skip the OTP
 * provider call. `marbete.reveal` is intentionally NOT grant-eligible
 * and never reaches this service.
 *
 * The grant is per-actor (session username) and per-scope. It is a
 * purely local construct: it does NOT change the quorum-otp provider
 * semantics — the upstream OTP is still single-use; the grant simply
 * lets the actor skip the per-op verify while the cache row is still
 * in the future.
 *
 * `now()` is injected for deterministic tests; production callers leave
 * it unset and the service reads `Date.now()`.
 */
import type pg from 'pg';

export interface OtpGrant {
  id: number;
  actor: string;
  scope: string;
  otp_id: string;
  created_at: Date;
  expires_at: Date;
}

export interface OtpGrantServiceOptions {
  /** TTL of a freshly-created grant, in milliseconds. */
  ttlMs: number;
  /** Injectable wall clock. Defaults to Date.now(). */
  now?: () => number;
}

export class OtpGrantService {
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly client: pg.Pool | pg.PoolClient,
    opts: OtpGrantServiceOptions,
  ) {
    if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
      throw new Error('otp_grant_ttl_must_be_positive');
    }
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Find an unexpired grant for (actor, scope). Returns `null` when no
   * row is in the future; callers treat that as "OTP required".
   *
   * Multiple grants may exist (the service never deletes expired rows
   * eagerly); the most recently created matching row wins so a freshly
   * verified OTP refreshes the actor's window.
   */
  async findActive(actor: string, scope: string): Promise<OtpGrant | null> {
    const r = await this.client.query<OtpGrant>(
      `SELECT id, actor, scope, otp_id, created_at, expires_at
         FROM otp_grants
        WHERE actor = $1 AND scope = $2 AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT 1`,
      [actor, scope],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Create a grant for (actor, scope) tied to `otpId`. The expires_at
   * is computed from `this.ttlMs` and the injected clock so tests can
   * advance time deterministically.
   */
  async create(actor: string, scope: string, otpId: string): Promise<OtpGrant> {
    const expiresAt = new Date(this.now() + this.ttlMs);
    const r = await this.client.query<OtpGrant>(
      `INSERT INTO otp_grants (actor, scope, otp_id, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, actor, scope, otp_id, created_at, expires_at`,
      [actor, scope, otpId, expiresAt],
    );
    const row = r.rows[0];
    if (!row) throw new Error('otp_grant_insert_failed');
    return row;
  }

  /**
   * Reads the resolved TTL in milliseconds. Exposed for the grant-status
   * route to format `expiresAt` consistently and for tests/diagnostics.
   */
  describe(): { ttlMs: number } {
    return { ttlMs: this.ttlMs };
  }
}