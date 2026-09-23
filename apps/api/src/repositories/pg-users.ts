/**
 * PostgreSQL repository for the users table.
 *
 * Mirrors the shape of pg-dispositivos.ts. Owns SQL only; the service
 * layer handles bcrypt verification, session issuance, audit emission,
 * and rate limiting.
 */
import type pg from 'pg';
import type { UserRole } from '@quorum-backoffice/shared';

type Client = pg.Pool | pg.PoolClient;

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  role: UserRole;
  created_at: Date;
  last_login_at: Date | null;
  disabled_at: Date | null;
}

export class PgUserRepo {
  constructor(private readonly client: Client) {}

  async findByEmail(email: string): Promise<UserRow | null> {
    const r = await this.client.query<UserRow>(
      `SELECT id, email, password_hash, role, created_at, last_login_at, disabled_at
         FROM users
        WHERE email = $1`,
      [email.toLowerCase()],
    );
    return r.rows[0] ?? null;
  }

  async findById(id: number): Promise<UserRow | null> {
    const r = await this.client.query<UserRow>(
      `SELECT id, email, password_hash, role, created_at, last_login_at, disabled_at
         FROM users
        WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async updateLastLogin(id: number): Promise<void> {
    await this.client.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [id]);
  }

  /**
   * Replace a user's stored password hash. Used by the auth service for
   * transparent on-login upgrades from legacy bcrypt to argon2id (see
   * `apps/api/src/services/auth-service.ts`).
   *
   * The `users` table has no `updated_at` column (see migration
   * `0005_auth.sql`); only `password_hash` is updated.
   */
  async updatePasswordHash(userId: number, newHash: string): Promise<void> {
    await this.client.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2`,
      [newHash, userId],
    );
  }
}
