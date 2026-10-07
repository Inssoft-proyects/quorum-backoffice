/**
 * Read-only students service: resolves a students_cache row by its
 * external Canvas user identifier and exposes a trimmed DTO surface.
 *
 * Mirrors audit-query-service.ts (read-only, no audit writes). The students
 * lookup never validates Canvas enrollment status for writes — that lives
 * in marbetes-service.ts. This service is a thin DTO mapper + 404 wrapper
 * over the repository.
 *
 * Naming: `canvasUserId` is the stable external id from Canvas; `id` is
 * the internal students_cache.id used only as a foreign key from marbetes.
 *
 * Since migration 0020_students_sis_id.sql the response shape carries
 * the new `sisId` (the SIS matrícula) and treats `fullName` / `email`
 * as nullable strings. Synthetic high-privacy students (rows with only
 * `canvas_user_id` + `sis_id` and NULL PII) round-trip cleanly through
 * the DTO with `fullName: null`, `email: null`, and the matrícula
 * exposed as `sisId`.
 */
import type pg from 'pg';
import { AppError } from '../lib/errors';
import { PgStudentRepo, type StudentRow } from '../repositories/pg-students';

interface ServiceDeps {
  pool: pg.Pool;
}

/**
 * The DTO surface returned by `GET /api/v1/students`. The shape
 * mirrors the shared `StudentResponse` Zod schema
 * (`packages/shared/src/dto/student.ts`) so the service stays in
 * lockstep with the OpenAPI doc.
 */
export interface StudentDetailResponse {
  id: number;
  canvasUserId: number;
  /**
   * SIS matrícula (6-char uppercase alnum). NULL for legacy rows
   * inserted before migration 0020. The wire surface is
   * `string | null` so a forward-compatible UI can render a
   * placeholder for un-sis'd rows without crashing.
   */
  sisId: string | null;
  /**
   * Canvas-side display name. NULL for synthetic high-privacy
   * rows (matrícula + canvas_user_id only).
   */
  fullName: string | null;
  /**
   * Canvas-side email. NULL for synthetic high-privacy rows.
   */
  email: string | null;
  isActive: boolean;
}

export class StudentsService {
  private readonly repo: PgStudentRepo;

  constructor(private readonly deps: ServiceDeps) {
    this.repo = new PgStudentRepo(deps.pool);
  }

  async findByCanvasId(canvasUserId: number): Promise<StudentDetailResponse> {
    const row = await this.repo.findByCanvasId(canvasUserId);
    if (!row) throw AppError.notFound(`student with canvas_user_id ${canvasUserId} not found`);
    return this.toResponse(row);
  }

  private toResponse(row: StudentRow): StudentDetailResponse {
    return {
      id: row.id,
      canvasUserId: row.canvas_user_id,
      sisId: row.sis_id,
      fullName: row.full_name,
      email: row.email,
      isActive: row.is_active,
    };
  }
}
