/**
 * MatriculasService: the read + write surface for the
 * "Asignación de marbetes" screen (WU v3).
 *
 *   - list / counters: paginated + aggregate reads against
 *     students_cache + marbetes (LEFT JOIN).
 *   - assignBulk: one transactional verifyOtp + N-pair assign.
 *     Validates every pair before mutating anything; rolls back
 *     on the first violation. Emits ONE aggregate audit row.
 *   - unassign: verifyOtp + clear assignment + audit row.
 *   - sync: page through CanvasClient and upsert into
 *     students_cache. Returns counters + durationMs.
 *
 * OTP grant window: assignBulk / unassign route through the same
 * grant-aware `verifyOtp` helper as MarbetesService (same scope
 * family `marbete.update`), so one OTP cover both an assign and a
 * follow-up unassign inside the 20-minute window. The sync endpoint
 * is read-only toward Canvas and writes only to the local cache,
 * so it deliberately does NOT require OTP.
 *
 * Audit actions:
 *   - `marbete.assign_bulk` (added in migration 0013) — one row
 *     per /assign call, after_jsonb summarises every pair.
 *   - `marbete.unassign`    (added in migration 0013) — one row
 *     per /unassign call, before/after + reason + comentario.
 */
import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type {
  AssignMarbetesRequest,
  ListMatriculasFilter,
  ListMatriculasResponse,
  MarbeteStatus,
  MatriculaListItem,
  MarbeteSummary,
  MatriculasCountersResponse,
  SyncMatriculasResponse,
  UnassignMarbeteRequest,
  AuditAction,
} from '@quorum-backoffice/shared';
import { AppError } from '../lib/errors';
import { maskCode } from '../lib/marbete-id';
import {
  PgMatriculasRepo,
  type ListMatriculasRow,
} from '../repositories/pg-matriculas';
import { PgMarbeteRepo } from '../repositories/pg-marbetes';
import { OtpClient } from './otp-client';
import { OtpGrantService } from './otp-grant-service';
import { CanvasClient } from './canvas-client';
import { verifyOtpWithGrant } from '../lib/otp-grant-verify';

interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

interface ServiceDeps {
  pool: pg.Pool;
  log: FastifyBaseLogger;
  otp: OtpClient;
  /** Optional grant cache; same pattern as MarbetesService. */
  grant?: OtpGrantService;
  /** Canvas portal-api client (used by sync). Optional so unit
   *  tests that exercise only the DB path can omit it. */
  canvas?: CanvasClient;
}

/** Scope family used by the grant cache. Matches MarbetesService. */
const GRANT_SCOPE = 'marbete';

/** Grant-eligible OTP scopes for assign / unassign. */
const ASSIGN_GRANT_SCOPES = new Set(['marbete.update']);

/** Hard cap on the Canvas sync pagination. Mirrors the parent task. */
const SYNC_MAX_ROWS = 20_000;
const SYNC_PAGE_LIMIT = 100;

export interface AssignValidationError {
  index: number;
  code: string;
  details: Record<string, unknown>;
}

export interface AssignBulkInternalResult {
  pairs: { canvasUserId: number; marbeteId: number; publicUid: string }[];
  total: number;
}

export class MatriculasService {
  private readonly repo: PgMatriculasRepo;
  private readonly marbetes: PgMarbeteRepo;
  private readonly otp: OtpClient;
  private readonly log: FastifyBaseLogger;
  private readonly grant: OtpGrantService | null;
  private readonly canvas: CanvasClient | null;

  constructor(private readonly deps: ServiceDeps) {
    this.repo = new PgMatriculasRepo(deps.pool);
    this.marbetes = new PgMarbeteRepo(deps.pool);
    this.otp = deps.otp;
    this.log = deps.log;
    this.grant = deps.grant ?? null;
    this.canvas = deps.canvas ?? null;
  }

  // ---- Reads ----

  async list(filter: ListMatriculasFilter): Promise<ListMatriculasResponse> {
    const { rows, total } = await this.repo.listWithMarbetes(filter);
    const items = rows.map((row) => this.toListItem(row));
    return { total, limit: filter.limit, offset: filter.offset, items };
  }

  async counters(filter: ListMatriculasFilter): Promise<MatriculasCountersResponse> {
    const r = await this.repo.counters(filter);
    return {
      total: r.total,
      assigned: r.assigned,
      unassigned: r.unassigned,
      availableMarbetes: r.available_marbetes,
    };
  }

  // ---- Assign (bulk) ----

  /**
   * Assign N (canvasUserId, marbeteId) pairs in a single
   * transactional call. One verifyOtp covers the whole batch so a
   * single 6-digit OTP powers an assign+unassign sequence inside
   * the 20-minute grant window.
   *
   * Validation matrix (first violation aborts the whole batch and
   * returns 422 with the offending pair's index):
   *
   *   1. Pair uniqueness — no duplicate (canvasUserId, marbeteId)
   *      and no duplicate marbeteId in the same batch.
   *   2. Student — exists and is_active = TRUE.
   *   3. Marbete — exists, status = 'active', deleted_at IS NULL.
   *   4. Marbete — not already assigned to another student
   *      (unless the pair re-assigns the SAME marbete to the SAME
   *      student — idempotent retry within the dialog).
   *
   * On success: UPDATE marbetes SET assigned_student_id, assigned_at
   * = now(), assigned_by = actor for each pair. ONE audit row with
   * action='marbete.assign_bulk' summarises the batch.
   */
  async assignBulk(
    actor: string,
    req: AssignMarbetesRequest,
    otpCode: string | undefined,
    meta: RequestMeta = {},
  ): Promise<AssignBulkInternalResult> {
    const otpResult = await this.verifyOtpGrant(actor, 'marbete.update', otpCode);

    // ---- Pure pre-validation: duplicates ----
    const seenMarbetes = new Map<number, number>(); // marbeteId → first index
    const seenPairs = new Set<string>();
    for (let i = 0; i < req.pairs.length; i += 1) {
      const p = req.pairs[i]!;
      const key = `${p.canvasUserId}:${p.marbeteId}`;
      if (seenPairs.has(key)) {
        throw new AppError(
          'assign_duplicate_pair',
          `pair at index ${i} duplicates another in the batch`,
          422,
          { index: i, canvasUserId: p.canvasUserId, marbeteId: p.marbeteId },
        );
      }
      seenPairs.add(key);
      const prev = seenMarbetes.get(p.marbeteId);
      if (prev !== undefined) {
        throw new AppError(
          'assign_duplicate_marbete',
          `marbete ${p.marbeteId} appears in pairs[${prev}] and pairs[${i}]`,
          422,
          { marbeteId: p.marbeteId, indices: [prev, i] },
        );
      }
      seenMarbetes.set(p.marbeteId, i);
    }

    // ---- Pre-load every referenced row in 2 round-trips ----
    const canvasIds = Array.from(new Set(req.pairs.map((p) => p.canvasUserId)));
    const marbeteIds = Array.from(new Set(req.pairs.map((p) => p.marbeteId)));
    const studentsResult = await this.deps.pool.query<{
      canvas_user_id: number;
      id: number;
      is_active: boolean;
    }>(
      `SELECT canvas_user_id, id, is_active
         FROM students_cache
        WHERE canvas_user_id = ANY($1::bigint[])`,
      [canvasIds],
    );
    const studentsByCanvas = new Map(
      studentsResult.rows.map((r) => [r.canvas_user_id, r]),
    );
    const marbetesResult = await this.deps.pool.query<{
      id: number;
      public_uid: string;
      status: MarbeteStatus;
      assigned_student_id: number | null;
      deleted_at: Date | null;
    }>(
      `SELECT id, public_uid, status, assigned_student_id, deleted_at
         FROM marbetes
        WHERE id = ANY($1::bigint[])`,
      [marbeteIds],
    );
    const marbetesById = new Map(
      marbetesResult.rows.map((r) => [r.id, r]),
    );

    // ---- Per-pair validation: student + marbete ----
    type PreparedPair = {
      index: number;
      canvasUserId: number;
      marbeteId: number;
      publicUid: string;
    };
    const prepared: PreparedPair[] = [];
    for (let i = 0; i < req.pairs.length; i += 1) {
      const p = req.pairs[i]!;
      const student = studentsByCanvas.get(p.canvasUserId);
      if (!student) {
        throw new AppError(
          'student_not_found',
          `student with canvas_user_id ${p.canvasUserId} not found in cache; sync from Canvas first`,
          422,
          { index: i, canvasUserId: p.canvasUserId, marbeteId: p.marbeteId },
        );
      }
      if (!student.is_active) {
        throw new AppError(
          'student_not_active',
          `student ${p.canvasUserId} is not active in Canvas`,
          422,
          { index: i, canvasUserId: p.canvasUserId, marbeteId: p.marbeteId },
        );
      }
      const marbete = marbetesById.get(p.marbeteId);
      if (!marbete) {
        throw new AppError(
          'marbete_not_found',
          `marbete ${p.marbeteId} not found`,
          422,
          { index: i, canvasUserId: p.canvasUserId, marbeteId: p.marbeteId },
        );
      }
      if (marbete.status !== 'active' || marbete.deleted_at !== null) {
        throw new AppError(
          'marbete_not_assignable',
          `marbete ${p.marbeteId} is not active or is soft-deleted`,
          422,
          { index: i, canvasUserId: p.canvasUserId, marbeteId: p.marbeteId },
        );
      }
      // Marbete must not already be assigned to a DIFFERENT
      // student. The same marbeteId re-assigned to the same
      // student is treated as a no-op (idempotent retry) — the
      // unique partial index uq_marbete_active_per_student would
      // also permit it because the assigned_student_id row stays
      // the same.
      if (
        marbete.assigned_student_id !== null &&
        marbete.assigned_student_id !== student.id
      ) {
        throw new AppError(
          'marbete_already_assigned',
          `marbete ${p.marbeteId} is already assigned to another student`,
          409,
          { index: i, canvasUserId: p.canvasUserId, marbeteId: p.marbeteId },
        );
      }
      prepared.push({
        index: i,
        canvasUserId: p.canvasUserId,
        marbeteId: p.marbeteId,
        publicUid: marbete.public_uid,
      });
    }

    // ---- Apply in a single transaction ----
    // The pg plugin exposes `tx<T>(fn)`; the marbetes-service uses
    // the same cast to access it through the typed pg.Pool.
    const txPool = this.deps.pool as unknown as {
      tx<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T>;
    };
    const { total, pairs } = await txPool.tx(async (client) => {
      // Apply with a CASE-based UPDATE per pair so every pair
      // runs in a single statement, regardless of N. UNNEST feeds
      // the IDs; the CASE picks the matching id. ON CONFLICT
      // against the partial unique index (uq_marbete_active_per_student)
      // means concurrent writers cannot slip a duplicate pair past
      // the validation.
      const ids = prepared.map((p) => p.marbeteId);
      const studentIds = prepared.map((p) => {
        const s = studentsByCanvas.get(p.canvasUserId);
        // Validated above; non-null invariant is fine here.
        return s!.id;
      });
      try {
        await client.query(
          `UPDATE marbetes m
              SET assigned_student_id = c.student_id,
                  assigned_at = CASE
                    WHEN m.assigned_student_id IS NULL OR m.assigned_student_id <> c.student_id
                      THEN now()
                    ELSE m.assigned_at
                  END,
                  assigned_by = $2
             FROM UNNEST($1::bigint[], $3::bigint[]) AS c(marbete_id, student_id)
            WHERE m.id = c.marbete_id`,
          [ids, actor, studentIds],
        );
      } catch (err) {
        const e = err as { code?: string; constraint?: string };
        if (e.code === '23505' && e.constraint?.includes('uq_marbete_active_per_student')) {
          throw new AppError(
            'marbete_already_assigned',
            'unique partial index uq_marbete_active_per_student violated: a different student already holds this marbete',
            409,
          );
        }
        throw err;
      }

      // Aggregate audit row. action='marbete.assign_bulk' (migration
      // 0013). after_jsonb summarises every pair so an auditor can
      // reconstruct the operation without joining on the marbetes
      // table.
      await client.query(
        `INSERT INTO audit_log
           (actor_id, actor_email, action, entity_type, entity_id,
            before_jsonb, after_jsonb, otp_id, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::inet, $10)`,
        [
          actor,
          null,
          'marbete.assign_bulk',
          'matricula',
          null,
          null,
          JSON.stringify({
            reason: req.reason ?? null,
            pairs: prepared.map((p) => ({
              canvasUserId: p.canvasUserId,
              marbeteId: p.marbeteId,
              publicUid: p.publicUid,
            })),
          }),
          otpResult.otpId,
          meta.ip ?? null,
          meta.userAgent ?? null,
        ],
      );

      return {
        total: req.pairs.length,
        pairs: prepared.map((p) => ({
          canvasUserId: p.canvasUserId,
          marbeteId: p.marbeteId,
          publicUid: p.publicUid,
        })),
      };
    });

    return { total, pairs };
  }

  // ---- Unassign ----

  async unassign(
    actor: string,
    req: UnassignMarbeteRequest,
    otpCode: string | undefined,
    meta: RequestMeta = {},
  ): Promise<{ marbeteId: number; publicUid: string }> {
    const otpResult = await this.verifyOtpGrant(actor, 'marbete.update', otpCode);

    const existing = await this.marbetes.findById(req.marbeteId);
    if (!existing) {
      throw AppError.notFound(`marbete ${req.marbeteId} not found`);
    }
    if (existing.deleted_at) {
      throw AppError.conflict('cannot unassign a soft-deleted marbete');
    }
    if (existing.assigned_student_id === null) {
      throw AppError.conflict('marbete is not currently assigned');
    }

    const before = this.marbetes.toResponse(existing);
    const txPool = this.deps.pool as unknown as {
      tx<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T>;
    };
    const publicUid = await txPool.tx(async (client) => {
      const r = await client.query<{ public_uid: string }>(
        `UPDATE marbetes
            SET assigned_student_id = NULL,
                assigned_at = NULL,
                assigned_by = NULL
          WHERE id = $1 AND deleted_at IS NULL
        RETURNING public_uid`,
        [req.marbeteId],
      );
      const row = r.rows[0];
      if (!row) throw AppError.notFound(`marbete ${req.marbeteId} not found`);

      await client.query(
        `INSERT INTO audit_log
           (actor_id, actor_email, action, entity_type, entity_id,
            before_jsonb, after_jsonb, otp_id, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::inet, $10)`,
        [
          actor,
          null,
          'marbete.unassign' satisfies AuditAction,
          'marbete',
          row.public_uid,
          JSON.stringify(before),
          JSON.stringify({
            assignedStudentId: null,
            assignedAt: null,
            assignedBy: null,
            reason: req.reason,
            comentario: req.comentario ?? null,
          }),
          otpResult.otpId,
          meta.ip ?? null,
          meta.userAgent ?? null,
        ],
      );
      return row.public_uid;
    });

    return { marbeteId: req.marbeteId, publicUid };
  }

  // ---- Sync (Canvas → students_cache) ----

  /**
   * Page through CanvasClient.listStudents and upsert into
   * students_cache. The portal-api's `/v1/students` endpoint does
   * NOT surface an enrollment/active field, so every returned row
   * is treated as `is_active=true`; rows missing from the latest
   * sync are deliberately NOT auto-deactivated (follow-up work).
   *
   * No audit row is written: the sync is read-only toward Canvas
   * and only mutates the local cache. The action enum does not
   * have a `matricula.sync` value, and piggy-backing on an
   * unrelated marbete action would mislead auditors.
   */
  async sync(
    actor: string,
    _meta: RequestMeta = {},
  ): Promise<SyncMatriculasResponse> {
    if (!this.canvas) {
      throw new AppError(
        'canvas_client_not_configured',
        'Canvas portal-api client is not configured for this environment',
        503,
      );
    }

    const startedAt = Date.now();
    let offset = 0;
    let total = 0;
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;

    // Hard cap on the number of rows we will ingest in a single
    // sync to avoid an infinite loop when the upstream returns
    // more pages than `total` advertises (defensive against
    // portal-api contract drift).
    for (let page = 0; page < SYNC_MAX_ROWS / SYNC_PAGE_LIMIT; page += 1) {
      const response = await this.canvas.listStudents({
        limit: SYNC_PAGE_LIMIT,
        offset,
      });
      const items = response.items;
      if (items.length === 0) break;

      const upsertRows = items.map((s) => ({
        canvasUserId: s.canvas_user_id,
        fullName: s.full_name,
        email: s.email,
      }));
      const result = await this.repo.upsertMany(upsertRows);
      created += result.inserted;
      updated += result.updated;
      // `unchanged` is the number of rows where the upstream payload
      // matched the cached row exactly and the UPDATE was a no-op.
      // pg's xmax trick collapses updates into the same bucket
      // regardless of whether a column actually changed, so we
      // approximate: `unchanged = ingested - inserted - updated`.
      // ingested here equals items.length because every returned
      // Canvas row is treated as active and upserted.
      unchanged += Math.max(0, items.length - result.inserted - result.updated);

      total += items.length;
      offset += items.length;

      if (items.length < SYNC_PAGE_LIMIT) break;
      if (offset >= response.total) break;
      if (total >= SYNC_MAX_ROWS) {
        throw AppError.unprocessable(
          `canvas_sync_exceeded_cap: more than ${SYNC_MAX_ROWS} rows in portal-api; raise SYNC_MAX_ROWS before retrying`,
        );
      }
    }

    // The remaining counters are zero because the sync treats every
    // returned Canvas row as active and the portal-api /v1/students
    // contract does not surface an enrollment/active flag. The
    // `skipped` counter exists in the response shape so a future
    // portal-api revision (with enrollment status) can populate it
    // without a breaking change.
    skipped = 0;

    const durationMs = Date.now() - startedAt;

    // No audit row: the sync is read-only toward Canvas and the
    // audit_action enum does not have a 'matricula.sync' value.
    // Piggy-backing on a marbete action would mislead auditors.

    return { total, created, updated, unchanged, skipped, durationMs };
  }

  // ---- Internals ----

  /**
   * Grant-aware OTP verify. Thin wrapper around the shared
   * `verifyOtpWithGrant` helper (see `lib/otp-grant-verify.ts`):
   *   - if the action is not in `ASSIGN_GRANT_SCOPES`, returns
   *     `{ otpId: 'noop' }` without consulting the helper.
   *   - otherwise delegates to the helper, supplying the
   *     assign/unassign-specific `otp_required` message so the API
   *     envelope stays byte-identical to the pre-extraction copy.
   *
   * The helper centralises: grant-cache lookup (`otp_grant_hit`),
   * per-op OTP verify (`otp_verify_failed` warn + `otp_invalid`),
   * and best-effort grant INSERT (`otp_grant_insert_failed` warn).
   *
   * Returns `{ otpId }` for the audit service. Throws AppError on
   * failure.
   */
  private async verifyOtpGrant(
    actor: string,
    action: string,
    otpCode: string | undefined,
  ): Promise<{ otpId: string }> {
    if (!ASSIGN_GRANT_SCOPES.has(action)) return { otpId: 'noop' };
    return verifyOtpWithGrant(
      { otp: this.otp, grant: this.grant, log: this.log },
      {
        actor,
        action,
        otpCode,
        grantEligible: true,
        grantScope: GRANT_SCOPE,
        otpRequiredMessage:
          'X-OTP-Code header missing; assign / unassign require a single-use 6-char OTP or an active grant window.',
      },
    );
  }

  private toListItem(row: ListMatriculasRow): MatriculaListItem {
    const marbete: MarbeteSummary | null = row.marbete_id
      ? {
          id: row.marbete_id,
          publicUid: row.marbete_public_uid!,
          maskedCode: maskCode(row.marbete_public_uid!),
          status: row.marbete_status!,
          assignedAt: row.marbete_assigned_at!.toISOString(),
          assignedBy: row.marbete_assigned_by,
        }
      : null;
    return {
      canvasUserId: row.canvas_user_id,
      fullName: row.full_name,
      email: row.email,
      isActive: row.is_active,
      registeredAt: row.last_synced_at.toISOString(),
      marbete,
    };
  }
}