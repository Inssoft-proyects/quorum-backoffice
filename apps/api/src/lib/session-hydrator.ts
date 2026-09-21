/**
 * Session hydrator: resolve a session token to the current user.
 *
 * Extracted from AuthService.getCurrentUser so the session plugin can
 * resolve cookies without spinning up a full AuthService (which also
 * wires Redis + audit dependencies) per request. Same semantics:
 * unknown / expired / disabled-user tokens all resolve to null.
 */
import type pg from 'pg';
import type { MeResponse } from '@quorum-backoffice/shared';
import { PgSessionRepo } from '../repositories/pg-sessions';
import { PgUserRepo } from '../repositories/pg-users';

export class SessionHydrator {
  private readonly sessions: PgSessionRepo;
  private readonly users: PgUserRepo;

  constructor(private readonly pool: pg.Pool) {
    this.sessions = new PgSessionRepo(pool);
    this.users = new PgUserRepo(pool);
  }

  /**
   * Resolve a session token to a user. Returns null if the session is
   * unknown, expired, or the user has been disabled since issuance.
   * Expired sessions are best-effort cleaned up asynchronously.
   */
  async resolve(token: string): Promise<MeResponse | null> {
    const session = await this.sessions.findById(token);
    if (!session) return null;
    if (session.expires_at.getTime() < Date.now()) {
      this.sessions.deleteById(token).catch(() => undefined);
      return null;
    }
    const user = await this.users.findById(session.user_id);
    if (!user || user.disabled_at !== null) return null;
    return { id: user.id, email: user.email, role: user.role };
  }
}
