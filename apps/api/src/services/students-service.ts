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
 */
import type pg from 'pg';
import { AppError } from '../lib/errors';
import { PgStudentRepo, type StudentRow } from '../repositories/pg-students';

interface ServiceDeps {
  pool: pg.Pool;
}

export interface StudentDetailResponse {
  id: number;
  canvasUserId: number;
  fullName: string;
  email: string;
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
      fullName: row.full_name,
      email: row.email,
      isActive: row.is_active,
    };
  }
}
