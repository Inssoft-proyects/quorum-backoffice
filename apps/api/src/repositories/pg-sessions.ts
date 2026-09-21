/**
 * PostgreSQL repository for the sessions table.
 *
 * Sessions are looked up by their opaque token (the session id is the
 * table primary key). Cookies carry the token verbatim; the server
 * resolves it to the owning user.
 */
import type pg from 'pg';

type Client = pg.Pool | pg.PoolClient;

export interface SessionRow {
  id: string;
  user_id: number;
  expires_at: Date;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
}

export class PgSessionRepo {
  constructor(private readonly client: Client) {}

  async findById(id: string): Promise<SessionRow | null> {
    const r = await this.client.query<SessionRow>(
      `SELECT id, user_id, expires_at, ip::text AS ip, user_agent, created_at
         FROM sessions
        WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async insert(args: {
    id: string;
    userId: number;
    expiresAt: Date;
    ip: string | null;
    userAgent: string | null;
  }): Promise<SessionRow> {
    const r = await this.client.query<SessionRow>(
      `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4::inet, $5)
       RETURNING id, user_id, expires_at, ip::text AS ip, user_agent, created_at`,
      [args.id, args.userId, args.expiresAt, args.ip, args.userAgent],
    );
    const row = r.rows[0];
    if (!row) throw new Error('session_insert_failed');
    return row;
  }

  async deleteById(id: string): Promise<void> {
    await this.client.query(`DELETE FROM sessions WHERE id = $1`, [id]);
  }

  async deleteExpired(): Promise<number> {
    const r = await this.client.query<{ count: number }>(
      `WITH d AS (
         DELETE FROM sessions WHERE expires_at < now() RETURNING 1
       )
       SELECT count(*)::int AS count FROM d`,
    );
    return r.rows[0]?.count ?? 0;
  }
}
