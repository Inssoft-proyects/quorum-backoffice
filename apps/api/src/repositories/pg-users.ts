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

const USER_COLUMNS =
  'id, email, username, password_hash, role, created_at, last_login_at, disabled_at';

export interface UserRow {
  id: number;
  email: string;
  /** Canonical BackOffice login identifier; NULL until assigned. */
  username: string | null;
  password_hash: string;
  role: UserRole;
  created_at: Date;
  last_login_at: Date | null;
  disabled_at: Date | null;
}

export class PgUserRepo {
  constructor(private readonly client: Client) {}

  /**
   * Resolve a BackOffice operator by their canonical login username.
   *
   * The lookup is case-insensitive (PostgreSQL citext-lite via LOWER())
   * so the API can accept `admin` / `Admin` / `ADMIN` interchangeably.
   * Returns null when the account exists but has no username assigned,
   * letting the auth service surface a stable `user_unmapped` error
   * without leaking that the row exists.
   */
  async findByUsername(username: string): Promise<UserRow | null> {
    const canonical = username.trim().toLowerCase();
    if (!canonical) return null;
    const r = await this.client.query<UserRow>(
      `SELECT ${USER_COLUMNS}
         FROM users
        WHERE username IS NOT NULL
          AND LOWER(username) = $1`,
      [canonical],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Resolve by primary key — unchanged, kept for other call sites that
   * already operate on an authenticated identity (session hydration,
   * last-login bump, etc).
   */
  async findById(id: number): Promise<UserRow | null> {
    const r = await this.client.query<UserRow>(
      `SELECT ${USER_COLUMNS}
         FROM users
        WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async updateLastLogin(id: number): Promise<void> {
    await this.client.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [id]);
  }
}
