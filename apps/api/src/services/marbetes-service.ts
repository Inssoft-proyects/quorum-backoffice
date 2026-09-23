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
import { PgStudentRepo } from '../repositories/pg-students';
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
  RevealMarbeteRequest,
  RevealMarbeteResponse,
  UpdateMarbeteRequest,
  AuditAction,
  BulkCreateMarbetesRequest,
  BulkCreateMarbetesResponse,
  BulkCreateMarbeteSuccess,
  BulkCreateMarbeteFailure,
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
  'marbete.reveal',
  'marbete.bulk_create',
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
   * Resolve a Canvas user identifier to the internal students_cache row.
   * Throws AppError(422, 'student_not_found') when the student is not in
   * cache, and AppError(422, 'student_not_active') when the row exists but
   * is marked inactive.
   *
   * Returns the resolved internal id (students_cache.id) so the repo can
   * persist the foreign key without further validation.
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

    let assignedInternalId: number | null = null;
    if (req.canvasUserId !== undefined) {
      assignedInternalId = await this.resolveCanvasStudent(req.canvasUserId);
    }

    let row: import('../repositories/pg-marbetes').MarbeteRow | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const publicUid = generatePublicUid();
      const codeHash = sha256Hex(req.code);
      try {
        row = await this.repo.insert({
          publicUid,
          codeHash,
          createdBy: actor,
          assignedStudentId: assignedInternalId,
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

    if (req.canvasUserId !== undefined) {
      let nextAssignedStudentId: number | null;
      if (req.canvasUserId === null) {
        nextAssignedStudentId = null;
      } else {
        nextAssignedStudentId = await this.resolveCanvasStudent(req.canvasUserId);
      }
      const set = await this.repo.assign(id, nextAssignedStudentId);
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
      req.canvasUserId !== undefined ? 'marbete.assign' : 'marbete.update';
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

  /**
   * WU #3 / Polish WU v4: bulk create up to 200 marbetes in one atomic
   * transaction. The full insert is gated by an OTP for `marbete.bulk_create`
   * (added to DESTRUCTIVE_ACTIONS). Duplicates — both intra-batch and
   * against existing rows — are reported as per-row failures without
   * aborting the rest of the batch; a single audit_log row is written
   * in the same transaction so a rollback also rolls back the audit.
   *
   * The audit `metadata` payload carries `{ count, source, fileName,
   * publicUids }` so a downstream auditor can reconcile the operation
   * without joining on the marbetes table.
   */
  async bulkCreate(
    actor: string,
    req: BulkCreateMarbetesRequest,
    source: 'json' | 'csv',
    fileName: string | null,
    otpCode: string | undefined,
    meta: RequestMeta = {},
  ): Promise<BulkCreateMarbetesResponse> {
    const otpResult = await this.verifyOtp(actor, 'marbete.bulk_create', otpCode);

    const failures: BulkCreateMarbeteFailure[] = [];
    const successes: BulkCreateMarbeteSuccess[] = [];

    // ---- Intra-batch duplicate detection (Map preserves insertion order) ----
    const seen = new Map<string, number>(); // code -> first-seen index
    const survivors: { index: number; code: string }[] = [];
    req.items.forEach((item, index) => {
      const firstIdx = seen.get(item.code);
      if (firstIdx === undefined) {
        seen.set(item.code, index);
        survivors.push({ index, code: item.code });
      } else {
        failures.push({
          index,
          line: null,
          code: item.code,
          reason: 'duplicate in batch',
        });
      }
    });

    // ---- DB duplicate pre-check ----
    const codeHashes = survivors.map((s) => sha256Hex(s.code));
    const existingHashes = await this.repo.findExistingCodeHashes(codeHashes);
    const existingSet = new Set(existingHashes);

    const ready: { index: number; code: string; codeHash: string; publicUid: string }[] = [];
    for (const survivor of survivors) {
      const codeHash = sha256Hex(survivor.code);
      if (existingSet.has(codeHash)) {
        failures.push({
          index: survivor.index,
          line: null,
          code: survivor.code,
          reason: 'code already exists',
        });
        continue;
      }
      ready.push({
        index: survivor.index,
        code: survivor.code,
        codeHash,
        publicUid: generatePublicUid(),
      });
    }

    let auditId: number | null = null;

    if (ready.length > 0) {
      // The Fastify pg plugin exposes `tx<T>(fn)` which manages the
      // BEGIN/COMMIT/ROLLBACK lifecycle and the client release for us.
      // All inserts and the audit_log row happen inside the same
      // transaction so a rollback also rolls back the audit.
      //
      // Audit policy: a `marbete.bulk_create` row is emitted only when
      // the batch had zero failures (i.e. every submitted item was
      // inserted). When any item was rejected as a duplicate, the
      // operator gets the per-row detail in the response body and
      // `auditId` stays null so the response shape distinguishes a
      // clean batch from a partially-rejected one.
      const txPool = this.deps.pool as unknown as {
        tx<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T>;
      };
      auditId = await txPool.tx(async (client) => {
        const inserted = await this.repo.bulkInsert(
          client,
          ready.map((r) => ({
            publicUid: r.publicUid,
            codeHash: r.codeHash,
            createdBy: actor,
          })),
        );

        // Map the inserted rows back to the original indexes for the
        // successes list (preserves input order).
        const byUid = new Map(inserted.map((row) => [row.public_uid, row]));
        for (const r of ready) {
          const row = byUid.get(r.publicUid);
          if (!row) throw AppError.internal('bulk_insert_returned_incomplete');
          successes.push({
            id: row.id,
            publicUid: row.public_uid,
            status: row.status,
          });
        }

        if (failures.length > 0) {
          // Partial-success batch: skip the audit row. The caller can
          // re-submit the failed codes separately if needed.
          return null;
        }

        const auditRow = await client.query<{ id: number }>(
          `INSERT INTO audit_log
             (actor_id, actor_email, action, entity_type, entity_id,
              after_jsonb, otp_id, ip, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::inet, $9)
           RETURNING id`,
          [
            actor,
            null,
            'marbete.bulk_create',
            'marbete',
            fileName ?? 'inline-json',
            JSON.stringify({
              count: req.items.length,
              created: successes.length,
              source,
              fileName,
              publicUids: successes.map((s) => s.publicUid),
              reason: req.reason ?? null,
            }),
            otpResult.otpId,
            meta.ip ?? null,
            meta.userAgent ?? null,
          ],
        );
        return auditRow.rows[0]?.id ?? null;
      });
    }
    // When `ready.length === 0` (the whole batch was duplicates) we
    // deliberately do NOT write an audit row: nothing was inserted, so
    // there's nothing to reconcile. `auditId` stays null per the contract.

    // Failures already carry their original input index, so a single
    // sort puts them in submission order for the operator. Successes
    // are appended in `ready` order (which itself preserves input
    // order thanks to the dup-detection map), so they don't need a
    // second pass.
    failures.sort((a, b) => a.index - b.index);

    return {
      total: req.items.length,
      created: successes.length,
      failed: failures.length,
      successes,
      failures,
      auditId,
    };
  }

  /**
   * WU #1: audit-only read that returns the unmasked publicUid.
   *
   * The marbete is NOT mutated. The original scanned code is never recoverable
   * (only code_hash is stored), so "reveal" simply lifts the mask so an
   * admin can read out the full identifier to a student or auditor.
   *
   * Side effects: a single audit_log entry with the supplied motivo +
   * comentario folded into `after_jsonb`. The OTP scope `marbete.reveal`
   * is forwarded to OtpClient.verify when AUTH_OTP_REQUIRED is enabled.
   *
   * Audit action is 'marbete.reveal' (enum value added in migration 0008).
   */
  async reveal(
    actor: string,
    id: number,
    req: RevealMarbeteRequest,
    otpCode: string | undefined,
    meta: RequestMeta = {},
  ): Promise<RevealMarbeteResponse> {
    const otpResult = await this.verifyOtp(actor, 'marbete.reveal', otpCode);

    const row = await this.repo.findById(id);
    if (!row) throw AppError.notFound(`marbete ${id} not found`);
    if (row.deleted_at) throw AppError.conflict('marbete already deleted');

    const audit = new AuditService(this.deps.pool);
    await audit.write({
      actorId: actor,
      // 'marbete.reveal' is added to the audit_action SQL enum by
      // migration 0008_audit_action_reveal.sql. The shared AuditAction
      // Zod enum intentionally stays in sync with the SQL enum on a
      // per-PR basis; cast here until the next shared-package bump.
      action: 'marbete.reveal' as AuditAction,
      entityType: 'marbete',
      entityId: row.public_uid,
      metadata: { motivo: req.motivo, comentario: req.comentario ?? null },
      otpId: otpResult.otpId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return {
      code: row.public_uid,
      revealedAt: new Date().toISOString(),
    };
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
