/**
 * Dispositivos service: orchestrates repository calls, OTP verification
 * (via OtpClient), and audit writes (via AuditService).
 *
 * Mirrors marbetes-service.ts exactly, adapted to the dispositivos table
 * (which has no code hashing or student hydration — purely CRUD + audit).
 */
import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../lib/errors';
import { PgDispositivoRepo } from '../repositories/pg-dispositivos';
import { PgStudentRepo } from '../repositories/pg-students';
import { OtpClient } from './otp-client';
import { AuditService } from './audit-service';
import type {
  CreateDispositivoRequest,
  DeleteDispositivoRequest,
  ListDispositivosFilter,
  ListDispositivosResponse,
  DispositivoDetailResponse,
  UpdateDispositivoRequest,
} from '@quorum-backoffice/shared';

interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** Body for an admin device-to-student assignment (B2b). */
export interface AssignDispositivoRequest {
  canvasUserId: number;
}

/**
 * Assignment result: the device detail plus the persisted owner state.
 * `assignedStudentId` is the internal `students_cache.id` (NOT the Canvas
 * user id, NOT the serial). NULL means inventory-only, no access rights.
 */
export type DispositivoAssignmentResponse = DispositivoDetailResponse & {
  assignedStudentId: number | null;
};

interface ServiceDeps {
  pool: pg.Pool;
  log: FastifyBaseLogger;
  otp: OtpClient;
}

const DESTRUCTIVE_ACTIONS = new Set([
  'dispositivo.create',
  'dispositivo.update',
  'dispositivo.revoke',
  'dispositivo.assign',
  'dispositivo.unassign',
]);

export class DispositivosService {
  private readonly repo: PgDispositivoRepo;
  private readonly otp: OtpClient;
  private readonly log: FastifyBaseLogger;

  constructor(private readonly deps: ServiceDeps) {
    this.repo = new PgDispositivoRepo(deps.pool);
    this.otp = deps.otp;
    this.log = deps.log;
  }

  /**
   * Verify OTP against quorum-otp. Throws AppError on failure.
   * For non-destructive operations (list, detail) this is a no-op.
   */
  private async verifyOtp(
    actor: string,
    action: string,
    otpCode: string | undefined,
  ): Promise<{ otpId: string }> {
    if (!DESTRUCTIVE_ACTIONS.has(action)) return { otpId: 'noop' };
    if (!otpCode) {
      throw new AppError(
        'otp_required',
        'X-OTP-Code header missing; destructive operations require a single-use 6-char OTP.',
        401,
        { action },
      );
    }
    const r = await this.otp.verify({ subject: actor, scope: action, code: otpCode });
    if (!r.ok) {
      this.log.warn({ actor, action, reason: r.reason }, 'otp_verify_failed');
      throw new AppError('otp_invalid', `otp verify rejected: ${r.reason}`, 401, {
        action,
        reason: r.reason,
      });
    }
    return { otpId: r.otpId };
  }

  async list(filter: ListDispositivosFilter): Promise<ListDispositivosResponse> {
    const { rows, total } = await this.repo.list(filter);
    const items = rows.map((r) => this.toDetail(r));
    return { total, limit: filter.limit, offset: filter.offset, items };
  }

  async detail(id: number): Promise<DispositivoDetailResponse> {
    const row = await this.repo.findById(id);
    if (!row) throw AppError.notFound(`dispositivo ${id} not found`);
    return this.toDetail(row);
  }

  async create(
    actor: string,
    req: CreateDispositivoRequest,
    otpCode: string | undefined,
    meta: RequestMeta = {},
  ): Promise<DispositivoDetailResponse> {
    const otpResult = await this.verifyOtp(actor, 'dispositivo.create', otpCode);

    let row;
    try {
      row = await this.repo.insert({
        serialNumber: req.serialNumber,
        brand: req.brand ?? null,
        model: req.model ?? null,
        createdBy: actor,
      });
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === '23505') {
        throw AppError.conflict(`serial_number '${req.serialNumber}' already exists`);
      }
      throw err;
    }

    const audit = new AuditService(this.deps.pool);
    await audit.write({
      actorId: actor,
      action: 'dispositivo.create',
      entityType: 'dispositivo',
      entityId: String(row.id),
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
    req: UpdateDispositivoRequest,
    otpCode: string | undefined,
    meta: RequestMeta = {},
  ): Promise<DispositivoDetailResponse> {
    const otpResult = await this.verifyOtp(actor, 'dispositivo.update', otpCode);

    const existing = await this.repo.findById(id);
    if (!existing) throw AppError.notFound(`dispositivo ${id} not found`);
    if (existing.status === 'revoked') throw AppError.conflict('cannot update a revoked dispositivo');

    const before = this.repo.toResponse(existing);
    const updated = await this.repo.update(id, { brand: req.brand, model: req.model });
    if (!updated) throw AppError.notFound(`dispositivo ${id} not found`);

    const audit = new AuditService(this.deps.pool);
    await audit.write({
      actorId: actor,
      action: 'dispositivo.update',
      entityType: 'dispositivo',
      entityId: String(updated.id),
      beforeJson: before,
      afterJson: this.repo.toResponse(updated),
      otpId: otpResult.otpId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return this.toDetail(updated);
  }

  async revoke(
    actor: string,
    id: number,
    req: DeleteDispositivoRequest,
    otpCode: string | undefined,
    meta: RequestMeta = {},
  ): Promise<DispositivoDetailResponse> {
    const otpResult = await this.verifyOtp(actor, 'dispositivo.revoke', otpCode);

    const existing = await this.repo.findById(id);
    if (!existing) throw AppError.notFound(`dispositivo ${id} not found`);
    if (existing.status === 'revoked') throw AppError.conflict('dispositivo already revoked');

    const before = this.repo.toResponse(existing);
    const row = await this.repo.softRevoke(id, req.reason);
    if (!row) throw AppError.conflict('dispositivo cannot be revoked (already revoked)');

    const audit = new AuditService(this.deps.pool);
    await audit.write({
      actorId: actor,
      action: 'dispositivo.revoke',
      entityType: 'dispositivo',
      entityId: String(row.id),
      beforeJson: before,
      afterJson: this.repo.toResponse(row),
      otpId: otpResult.otpId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return this.toDetail(row);
  }

  private toDetail(
    row: import('../repositories/pg-dispositivos').DispositivoRow,
  ): DispositivoDetailResponse {
    return this.repo.toResponse(row);
  }

  /**
   * Audit snapshot for assignment flows: the device response plus the
   * persisted owner state so before/after diffs show both sides of a
   * (re)assignment. The serial travels only inside the audit row (same as
   * the existing CRUD audits), never through denial messages.
   */
  private snapshot(
    row: import('../repositories/pg-dispositivos').DispositivoRow,
  ): DispositivoAssignmentResponse {
    return {
      ...this.repo.toResponse(row),
      assignedStudentId: row.assigned_student_id ?? null,
    };
  }

  /**
   * Resolve a Canvas user id to the internal `students_cache.id`, fail-closed:
   * only an existing ACTIVE student may own a device. Mirrors the marbetes
   * assignment semantics exactly (same error codes and status).
   */
  private async resolveCanvasStudent(canvasUserId: number): Promise<number> {
    const studentRepo = new PgStudentRepo(this.deps.pool);
    const row = await studentRepo.findByCanvasId(canvasUserId);
    if (!row) {
      throw new AppError(
        'student_not_found',
        'student not found in cache; sync from Canvas first',
        422,
        { canvasUserId },
      );
    }
    if (!row.is_active) {
      throw new AppError(
        'student_not_active',
        'student is not active in Canvas',
        422,
        { canvasUserId },
      );
    }
    return row.id;
  }

  /**
   * B2b: admin-only, OTP-gated assignment of a device to a Canvas student.
   *
   * Fail-closed: 404 for unknown devices, 409 for revoked devices (a revoked
   * device must never gain an owner), 422 for missing/inactive students.
   * Reassignment is allowed and audited with both states.
   */
  async assign(
    actor: string,
    id: number,
    req: AssignDispositivoRequest,
    otpCode: string | undefined,
    meta: RequestMeta = {},
  ): Promise<DispositivoAssignmentResponse> {
    const otpResult = await this.verifyOtp(actor, 'dispositivo.assign', otpCode);

    const existing = await this.repo.findById(id);
    if (!existing) throw AppError.notFound(`dispositivo ${id} not found`);
    if (existing.status === 'revoked') {
      throw AppError.conflict('cannot assign a revoked dispositivo');
    }

    const studentId = await this.resolveCanvasStudent(req.canvasUserId);

    const before = this.snapshot(existing);
    const updated = await this.repo.assignStudent(id, studentId);
    if (!updated) throw AppError.notFound(`dispositivo ${id} not found`);

    const audit = new AuditService(this.deps.pool);
    await audit.write({
      actorId: actor,
      action: 'dispositivo.assign',
      entityType: 'dispositivo',
      entityId: String(updated.id),
      beforeJson: before,
      afterJson: this.snapshot(updated),
      otpId: otpResult.otpId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return this.snapshot(updated);
  }

  /**
   * B2b: admin-only, OTP-gated removal of a device owner.
   *
   * Clearing an owner can never grant access, so it is allowed even on a
   * revoked device. A no-op unassign is rejected (409) to avoid burning an
   * OTP without a state change.
   */
  async unassign(
    actor: string,
    id: number,
    otpCode: string | undefined,
    meta: RequestMeta = {},
  ): Promise<DispositivoAssignmentResponse> {
    const otpResult = await this.verifyOtp(actor, 'dispositivo.unassign', otpCode);

    const existing = await this.repo.findById(id);
    if (!existing) throw AppError.notFound(`dispositivo ${id} not found`);
    if (existing.assigned_student_id === null) {
      throw new AppError('device_not_assigned', 'dispositivo has no assigned student', 409, {
        dispositivoId: id,
      });
    }

    const before = this.snapshot(existing);
    const updated = await this.repo.assignStudent(id, null);
    if (!updated) throw AppError.notFound(`dispositivo ${id} not found`);

    const audit = new AuditService(this.deps.pool);
    await audit.write({
      actorId: actor,
      action: 'dispositivo.unassign',
      entityType: 'dispositivo',
      entityId: String(updated.id),
      beforeJson: before,
      afterJson: this.snapshot(updated),
      otpId: otpResult.otpId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return this.snapshot(updated);
  }
}