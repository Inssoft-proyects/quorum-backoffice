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

interface ServiceDeps {
  pool: pg.Pool;
  log: FastifyBaseLogger;
  otp: OtpClient;
}

const DESTRUCTIVE_ACTIONS = new Set([
  'dispositivo.create',
  'dispositivo.update',
  'dispositivo.revoke',
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
}