/**
 * Marbetes service: orchestrates repository calls, hashing, masking, and
 * (TODO WU3b) OTP enforcement + audit writes.
 *
 * WU3a intentionally leaves the OTP guard as a TODO; the routes call the
 * service with a `requireOtp: false` flag and the service silently trusts
 * the caller. WU3b wires the real guard.
 */
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../lib/errors';
import {
  generatePublicUid,
  maskCode,
  sha256Hex,
} from '../lib/marbete-id';
import { PgMarbeteRepo } from '../repositories/pg-marbetes';
import type {
  CreateMarbeteRequest,
  DeleteMarbeteRequest,
  ListMarbetesFilter,
  ListMarbetesResponse,
  MarbeteCountersResponse,
  MarbeteDetailResponse,
  MarbeteStatus,
  UpdateMarbeteRequest,
} from '@quorum-backoffice/shared';

interface ServiceDeps {
  pool: import('pg').Pool;
  log: FastifyBaseLogger;
}

export class MarbetesService {
  private readonly repo: PgMarbeteRepo;
  constructor(private readonly deps: ServiceDeps) {
    this.repo = new PgMarbeteRepo(deps.pool);
  }

  /**
   * WU3b: replace this with the real OTP verifier (quorum-otp /v1/otps/verify).
   * WU3a: trusts the caller so the CRUD flow can be exercised end-to-end.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async _verifyOtpForAction(_actor: string, _action: string, _code?: string): Promise<void> {
    // TODO WU3b: real OTP verification.
    return;
  }

  async list(filter: ListMarbetesFilter): Promise<ListMarbetesResponse> {
    const { rows, total } = await this.repo.list(filter);
    const items = await Promise.all(rows.map((r) => this.toDetail(r)));
    return { total, limit: filter.limit, offset: filter.offset, items };
  }

  async counters(): Promise<MarbeteCountersResponse> {
    return this.repo.counters();
  }

  async detail(id: number): Promise<MarbeteDetailResponse> {
    const row = await this.repo.findById(id);
    if (!row) throw AppError.notFound(`marbete ${id} not found`);
    return this.toDetail(row);
  }

  async create(
    actor: string,
    req: CreateMarbeteRequest,
    otpCode: string | undefined,
  ): Promise<MarbeteDetailResponse> {
    await this._verifyOtpForAction(actor, 'marbete.create', otpCode);

    // Generate a unique public_uid; retry on the rare collision.
    let attempt = 0;
    let row: import('../repositories/pg-marbetes').MarbeteRow | null = null;
    while (attempt < 5) {
      const publicUid = generatePublicUid();
      const codeHash = sha256Hex(req.code);
      try {
        row = await this.repo.insert({
          publicUid,
          codeHash,
          createdBy: actor,
          assignedStudentId: req.assignedStudentId ?? null,
        });
        break;
      } catch (err) {
        const e = err as { code?: string; constraint?: string };
        if (e.code === '23505' && e.constraint?.includes('public_uid')) {
          attempt += 1;
          continue;
        }
        throw err;
      }
    }
    if (!row) throw AppError.internal('failed to allocate unique public_uid');
    return this.toDetail(row);
  }

  async update(
    actor: string,
    id: number,
    req: UpdateMarbeteRequest,
    otpCode: string | undefined,
  ): Promise<MarbeteDetailResponse> {
    await this._verifyOtpForAction(actor, 'marbete.update', otpCode);

    const existing = await this.repo.findById(id);
    if (!existing) throw AppError.notFound(`marbete ${id} not found`);
    if (existing.deleted_at) throw AppError.conflict('cannot update a soft-deleted marbete');

    if (req.assignedStudentId !== undefined) {
      if (req.assignedStudentId !== null) {
        const student = await this.repo.studentOf(req.assignedStudentId);
        if (!student) throw AppError.badRequest('assignedStudentId not found');
      }
      const updated = await this.repo.assign(id, req.assignedStudentId);
      if (!updated) throw AppError.notFound(`marbete ${id} not found`);
      // Reload to capture new assigned_at.
      const refreshed = await this.repo.findById(id);
      if (!refreshed) throw AppError.notFound(`marbete ${id} not found`);
      return this.toDetail(refreshed);
    }
    if (req.status) {
      const updated = await this.repo.setStatus(id, req.status as MarbeteStatus);
      if (!updated) throw AppError.notFound(`marbete ${id} not found`);
      return this.toDetail(updated);
    }
    return this.toDetail(existing);
  }

  async delete(
    actor: string,
    id: number,
    req: DeleteMarbeteRequest,
    otpCode: string | undefined,
  ): Promise<MarbeteDetailResponse> {
    await this._verifyOtpForAction(actor, 'marbete.delete', otpCode);

    const existing = await this.repo.findById(id);
    if (!existing) throw AppError.notFound(`marbete ${id} not found`);
    if (existing.deleted_at) {
      throw AppError.conflict('marbete already deleted');
    }

    const row = await this.repo.softDelete(id, req.reason);
    if (!row) throw AppError.notFound(`marbete ${id} not found`);
    return this.toDetail(row);
  }

  private async toDetail(
    row: import('../repositories/pg-marbetes').MarbeteRow,
  ): Promise<MarbeteDetailResponse> {
    const base = this.repo.toResponse(row);
    let student: MarbeteDetailResponse['student'] = null;
    if (row.assigned_student_id !== null) {
      const s = await this.repo.studentOf(row.assigned_student_id);
      if (s) {
        student = {
          id: s.id,
          canvasUserId: s.canvas_user_id,
          fullName: s.full_name,
          email: s.email,
        };
      }
    }
    return {
      ...base,
      maskedCode: maskCode(row.public_uid),
      student,
    };
  }
}
