/**
 * Marbetes service: orchestrates repository calls, hashing, masking, OTP
 * verification (via OtpClient), and audit writes (via AuditService).
 *
 * WU3b wires the real OTP guard and audit emission. The Canvas client
 * is consumed by the canvas-hydration preHandler (separate concern).
 */
import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../lib/errors';
import { generatePublicUid, maskCode, sha256Hex } from '../lib/marbete-id';
import { PgMarbeteRepo } from '../repositories/pg-marbetes';
import { OtpClient } from './otp-client';
import { AuditService } from './audit-service';
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

interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

interface ServiceDeps {
  pool: pg.Pool;
  log: FastifyBaseLogger;
  otp: OtpClient;
}

const DESTRUCTIVE_ACTIONS = new Set([
  'marbete.create',
  'marbete.update',
  'marbete.delete',
]);

export class MarbetesService {
  private readonly repo: PgMarbeteRepo;
  private readonly otp: OtpClient;
  private readonly log: FastifyBaseLogger;

  constructor(private readonly deps: ServiceDeps) {
    this.repo = new PgMarbeteRepo(deps.pool);
    this.otp = deps.otp;
    this.log = deps.log;
  }

  /**
   * Verify OTP against quorum-otp. Throws AppError on failure.
   * For non-destructive operations (list, counters, detail) this is a no-op.
   */
  private async verifyOtp(
    actor: string,
    action: string,
    otpCode: string | undefined,
  ): Promise<{ otpId: string }> {
    if (!DESTRUCTIVE_ACTIONS.has(action)) return { otpId: 'noop' };
    if (!otpCode) {
      throw new AppError('otp_required', 'X-OTP-Code header missing; destructive operations require a single-use 6-char OTP.', 401, {
        action,
      });
    }
    const r = await this.otp.verify({ subject: actor, scope: action, code: otpCode });
    if (!r.ok) {
      this.log.warn({ actor, action, reason: r.reason }, 'otp_verify_failed');
      throw new AppError('otp_invalid', `otp verify rejected: ${r.reason}`, 401, { action, reason: r.reason });
    }
    return { otpId: r.otpId };
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
    meta: RequestMeta = {},
  ): Promise<MarbeteDetailResponse> {
    const otpResult = await this.verifyOtp(actor, 'marbete.create', otpCode);

    let row: import('../repositories/pg-marbetes').MarbeteRow | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
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
        if (e.code === '23505' && e.constraint?.includes('public_uid')) continue;
        throw err;
      }
    }
    if (!row) throw AppError.internal('failed to allocate unique public_uid');

    const audit = new AuditService(this.deps.pool);
    await audit.write({
      actorId: actor,
      action: 'marbete.create',
      entityType: 'marbete',
      entityId: row.public_uid,
      afterJson: this.repo.toResponse(row),
      otpId: otpResult.otpId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return this.toDetail(row);
  }

  async update(
    actor: string,
    id: number,
    req: UpdateMarbeteRequest,
    otpCode: string | undefined,
    meta: RequestMeta = {},
  ): Promise<MarbeteDetailResponse> {
    const otpResult = await this.verifyOtp(actor, 'marbete.update', otpCode);

    const existing = await this.repo.findById(id);
    if (!existing) throw AppError.notFound(`marbete ${id} not found`);
    if (existing.deleted_at) throw AppError.conflict('cannot update a soft-deleted marbete');

    const before = this.repo.toResponse(existing);
    let updated: import('../repositories/pg-marbetes').MarbeteRow;

    if (req.assignedStudentId !== undefined) {
      if (req.assignedStudentId !== null) {
        const student = await this.repo.studentOf(req.assignedStudentId);
        if (!student) throw AppError.badRequest('assignedStudentId not found');
      }
      const set = await this.repo.assign(id, req.assignedStudentId);
      if (!set) throw AppError.notFound(`marbete ${id} not found`);
      const refreshed = await this.repo.findById(id);
      if (!refreshed) throw AppError.notFound(`marbete ${id} not found`);
      updated = refreshed;
    } else if (req.status) {
      const set = await this.repo.setStatus(id, req.status as MarbeteStatus);
      if (!set) throw AppError.notFound(`marbete ${id} not found`);
      updated = set;
    } else {
      updated = existing;
    }

    const audit = new AuditService(this.deps.pool);
    const action =
      req.assignedStudentId !== undefined ? 'marbete.assign' : 'marbete.update';
    await audit.write({
      actorId: actor,
      action,
      entityType: 'marbete',
      entityId: updated.public_uid,
      beforeJson: before,
      afterJson: this.repo.toResponse(updated),
      otpId: otpResult.otpId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return this.toDetail(updated);
  }

  async delete(
    actor: string,
    id: number,
    req: DeleteMarbeteRequest,
    otpCode: string | undefined,
    meta: RequestMeta = {},
  ): Promise<MarbeteDetailResponse> {
    const otpResult = await this.verifyOtp(actor, 'marbete.delete', otpCode);

    const existing = await this.repo.findById(id);
    if (!existing) throw AppError.notFound(`marbete ${id} not found`);
    if (existing.deleted_at) throw AppError.conflict('marbete already deleted');

    const before = this.repo.toResponse(existing);
    const row = await this.repo.softDelete(id, req.reason);
    if (!row) throw AppError.notFound(`marbete ${id} not found`);

    const audit = new AuditService(this.deps.pool);
    await audit.write({
      actorId: actor,
      action: 'marbete.delete',
      entityType: 'marbete',
      entityId: row.public_uid,
      beforeJson: before,
      afterJson: this.repo.toResponse(row),
      otpId: otpResult.otpId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
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
    return { ...base, maskedCode: maskCode(row.public_uid), student };
  }
}
