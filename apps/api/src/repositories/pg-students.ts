/**
 * PostgreSQL repository for the students_cache table.
 *
 * Mirrors the snake_case-at-SQL-boundary + camelCase-response pattern used
 * by pg-marbetes.ts and pg-dispositivos.ts.
 *
 * Reads only — writes happen through the WU3 canvas-hydration path or the
 * WU8b1 marbete assignment resolution (which uses canvas_user_id, not the
 * internal id).
 */
import type pg from 'pg';

type Client = pg.Pool | pg.PoolClient;

export interface StudentRow {
  id: number;
  canvas_user_id: number;
  full_name: string;
  email: string;
  last_synced_at: Date;
  is_active: boolean;
}

export class PgStudentRepo {
  constructor(private readonly client: Client) {}

  async findByCanvasId(canvasUserId: number): Promise<StudentRow | null> {
    const r = await this.client.query<StudentRow>(
      `SELECT id, canvas_user_id, full_name, email, last_synced_at, is_active
         FROM students_cache
        WHERE canvas_user_id = $1`,
      [canvasUserId],
    );
    return r.rows[0] ?? null;
  }
}
