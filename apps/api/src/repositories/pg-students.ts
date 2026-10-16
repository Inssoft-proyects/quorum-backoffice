/**
 * PostgreSQL repository for the students_cache table.
 *
 * Mirrors the snake_case-at-SQL-boundary + camelCase-response pattern used
 * by pg-marbetes.ts and pg-dispositivos.ts.
 *
 * Reads only — writes happen through the WU3 canvas-hydration path or the
 * WU8b1 marbete assignment resolution (which uses canvas_user_id, not the
 * internal id).
 *
 * Since migration 0020_students_sis_id.sql:
 *   - `sis_id` is a nullable column with a UNIQUE partial index. We
 *     surface it on the row as `sis_id: string | null` so the
 *     service mapper can put it on the DTO (`StudentResponse.sisId`).
 *   - `full_name` and `email` are nullable. The Canvas hydration
 *     path may leave them NULL for synthetic high-privacy rows
 *     (a row identified by `sis_id` + `canvas_user_id` only).
 *     The mapper must therefore treat them as `string | null`,
 *     NOT as required fields.
 */
import type pg from 'pg';

type Client = pg.Pool | pg.PoolClient;

export interface StudentRow {
  id: number;
  canvas_user_id: number;
  /**
   * SIS matrícula (6-char uppercase alnum). NULL for legacy rows
   * inserted before 0020, and the surface identity for synthetic
   * high-privacy rows. The unique constraint is partial (see the
   * migration) so multiple NULL rows coexist.
   */
  sis_id: string | null;
  /**
   * Canvas-side display name. Nullable since 0020.
   */
  full_name: string | null;
  /**
   * Canvas-side email. Nullable since 0020.
   */
  email: string | null;
  last_synced_at: Date;
  is_active: boolean;
}

export class PgStudentRepo {
  constructor(private readonly client: Client) {}

  async findByCanvasId(canvasUserId: number): Promise<StudentRow | null> {
    const r = await this.client.query<StudentRow>(
      `SELECT id, canvas_user_id, sis_id, full_name, email, last_synced_at, is_active
         FROM students_cache
        WHERE canvas_user_id = $1`,
      [canvasUserId],
    );
    return r.rows[0] ?? null;
  }
}
