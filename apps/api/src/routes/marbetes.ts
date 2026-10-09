/**
 * Marbetes REST routes (prefix /api/v1/marbetes).
 *
 * WU3b:
 *   - OTP is enforced on POST/PATCH/DELETE via X-OTP-Code header
 *   - Every destructive op also emits an audit_log entry (via AuditService)
 *
 * WU #5 (v3 destroy grant):
 *   - Destructive marbete ops (create / update+assign / delete /
 *     bulk_create) consult a per-actor grant cache before requiring
 *     an OTP. Within an active 20-minute window the operator may
 *     proceed WITHOUT re-entering an OTP. `marbete.reveal` always
 *     requires a fresh per-op OTP and is NOT grant-eligible.
 *   - GET /api/v1/marbetes/otp-grant exposes the actor's current
 *     window so the UI can hide the OTP field while it is active.
 *
 * Auth (WU6) replaces `x-test-actor` with `req.session.user.id`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BulkCreateMarbetesRequest,
  BulkXlsxCreateRequest,
  CreateMarbeteRequest,
  DeleteMarbeteRequest,
  ListMarbetesFilter,
  MarbeteIdParam,
  RevealMarbeteRequest,
  UpdateMarbeteRequest,
  type BulkFailureCategory,
  type BulkXlsxCreateResponse,
  type OtpGrantStatusResponse,
} from '@quorum-backoffice/shared';
import { MarbetesService } from '../services/marbetes-service';
import { OtpClient } from '../services/otp-client';
import { OtpGrantService } from '../services/otp-grant-service';
import { requireSession, requireRole } from '../plugins/rbac';
import { parseCsvCodes } from '../lib/marbete-id';
import {
  buildXlsxErrorsWorkbook,
  decodeBase64Strict,
  parseXlsxBuffer,
  XLSX_MAX_DECODED_BYTES,
  CATEGORY_REASON_ES,
  type XlsxRowFailure,
} from '../lib/marbete-xlsx';
import { AppError } from '../lib/errors';

function actorFromRequest(req: FastifyRequest): string {
  const u = req.session?.user;
  if (!u) return 'dev-user';
  // OTPs are issued bound to the canonical username (lower/trim), matching
  // the login flow. Fall back to email only for legacy accounts without a
  // username so verification does not fail on a subject mismatch.
  const username = u.username?.trim().toLowerCase();
  return username && username.length > 0 ? username : u.email;
}

function otpFromRequest(req: FastifyRequest): string | undefined {
  const otpHeader = req.headers['x-otp-code'];
  return typeof otpHeader === 'string' && otpHeader.length > 0 ? otpHeader : undefined;
}

function metaFromRequest(req: FastifyRequest): { ip: string | null; userAgent: string | null } {
  return {
    ip: req.ip ?? null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  };
}

export async function registerMarbetesRoutes(app: FastifyInstance): Promise<void> {
  // B7a (P5.1): see the dispositivos twin comment. The HMAC service
  // identity on destructive marbetes operations must be the
  // operator-configured OTP_SERVICE_NAME, not the OtpClient default.
  const otp = new OtpClient({
    baseUrl: app.config.OTP_SERVICE_URL,
    serviceToken: app.config.OTP_SERVICE_TOKEN,
    serviceName: app.config.OTP_SERVICE_NAME,
  });

  // Per-actor OTP grant cache. TTL is driven by config so operators can
  // tune the window per environment. The service stays constructable
  // without it (existing tests that omit `deps.grant` keep the strict
  // per-op OTP behaviour).
  const grantTtlMs = app.config.OTP_GRANT_TTL_MINUTES * 60 * 1000;
  const grant = new OtpGrantService(app.pg as unknown as import('pg').Pool, {
    ttlMs: grantTtlMs,
  });

  const getService = (): MarbetesService =>
    new MarbetesService({
      pool: app.pg as unknown as import('pg').Pool,
      log: app.log,
      otp,
      grant,
    });

  app.get('/api/v1/marbetes/counters', { preHandler: requireSession() }, async () => {
    const svc = getService();
    return svc.counters();
  });

  // WU #5 (v3 destroy grant): expose the session actor's grant cache so
  // the UI can decide whether to hide the OTP input field. Backoffice
  // uses the same response shape regardless of whether the cache is
  // configured: `{ active: false, expiresAt: null }` means "OTP
  // required", which is the safe default for an environment that has
  // not wired the grant service.
  app.get<{ Reply: OtpGrantStatusResponse }>(
    '/api/v1/marbetes/otp-grant',
    { preHandler: requireSession() },
    async (req, reply) => {
      const actor = actorFromRequest(req);
      const svc = getService();
      const status = await svc.getGrantStatus(actor);
      reply.header('cache-control', 'no-store');
      return status;
    },
  );

  app.get('/api/v1/marbetes', { preHandler: requireSession() }, async (req) => {
    const filter = ListMarbetesFilter.parse(req.query);
    const svc = getService();
    return svc.list(filter);
  });

  app.get<{ Params: { id: string } }>(
    '/api/v1/marbetes/:id',
    { preHandler: requireSession() },
    async (req, reply) => {
      const { id } = MarbeteIdParam.parse(req.params);
      const svc = getService();
      const detail = await svc.detail(id);
      reply.header('cache-control', 'no-store');
      return detail;
    },
  );

  app.post('/api/v1/marbetes', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = CreateMarbeteRequest.parse(req.body);
    const actor = actorFromRequest(req);
    const otp = otpFromRequest(req);
    const meta = metaFromRequest(req);
    const svc = getService();
    const created = await svc.create(actor, body, otp, meta);
    reply.status(201);
    reply.header('location', `/api/v1/marbetes/${created.id}`);
    return created;
  });

  // WU #3 / Polish WU v4: bulk create up to 200 marbetes in one transactional
  // call. Admin-only + OTP-required (scope `marbete.bulk_create`). Per-row
  // outcomes are returned in the response body.
  app.post('/api/v1/marbetes/bulk', { preHandler: requireRole('admin') }, async (req) => {
    const body = BulkCreateMarbetesRequest.parse(req.body);
    const actor = actorFromRequest(req);
    const otp = otpFromRequest(req);
    const meta = metaFromRequest(req);
    const svc = getService();
    return svc.bulkCreate(actor, body, 'json', null, otp, meta);
  });

  // CSV variant: parses the upload server-side so the frontend dialog can
  // stay dumb (it sends `text` + `fileName`). Same OTP / role gate.
  app.post(
    '/api/v1/marbetes/bulk-csv',
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const parsed = z
        .object({
          text: z.string().min(1),
          reason: z.string().max(500).optional(),
          fileName: z.string().min(1).max(255),
        })
        .parse(req.body);
      const { codes, errors } = parseCsvCodes(parsed.text);
      if (errors.length > 0) {
        reply.code(400);
        return {
          error: 'csv_parse_failed',
          message: `${errors.length} row(s) could not be parsed`,
          errors,
        };
      }
      const items = codes.map((row) => ({ code: row.code }));
      const actor = actorFromRequest(req);
      const otp = otpFromRequest(req);
      const meta = metaFromRequest(req);
      const svc = getService();
      return svc.bulkCreate(
        actor,
        { items, reason: parsed.reason },
        'csv',
        parsed.fileName,
        otp,
        meta,
      );
    },
  );

  // .xlsx variant of bulk-create. Same admin role + OTP/grant window
  // as /bulk (scope family `marbete.bulk_create`). The frontend sends
  // `{ fileName, contentBase64, reason? }`; we decode, parse, classify,
  // forward valid survivors to the DB layer, and synthesise a category
  // histogram + a downloadable errors workbook for the UI to surface.
  app.post<{ Reply: BulkXlsxCreateResponse }>(
    '/api/v1/marbetes/bulk-xlsx',
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const body = BulkXlsxCreateRequest.parse(req.body);

      let buffer: Buffer;
      try {
        buffer = decodeBase64Strict(body.contentBase64);
      } catch (err) {
        throw new AppError(
          'xlsx_parse_failed',
          `contentBase64 is not valid: ${(err as Error).message}`,
          400,
        );
      }

      const parsed = await parseXlsxBuffer(buffer);
      if (parsed.parseError === 'xlsx_too_large') {
        throw new AppError(
          'xlsx_too_large',
          `workbook exceeds the ${XLSX_MAX_DECODED_BYTES}-byte decoded limit`,
          400,
          { maxBytes: XLSX_MAX_DECODED_BYTES },
        );
      }
      if (parsed.parseError === 'xlsx_parse_failed' || parsed.header === null) {
        throw new AppError(
          'xlsx_parse_failed',
          'first sheet must contain the header "Número de marbete" in row 1, column A',
          400,
        );
      }

      // Forward the survivors to the existing bulkCreate service so
      // inventory-level dedup (already_exists) and the transactional
      // audit/insert path are reused unchanged. The survivors preserve
      // the original xlsx row order via `index` -> `xlsxRow`.
      const items = parsed.survivors.map((s) => ({ code: s.code }));
      const actor = actorFromRequest(req);
      const otp = otpFromRequest(req);
      const meta = metaFromRequest(req);
      const svc = getService();
      const bulk = await svc.bulkCreate(
        actor,
        { items, reason: body.reason },
        'xlsx',
        body.fileName,
        otp,
        meta,
      );

      // Translate bulkCreate's index-keyed failures back to xlsx rows.
      const xlsxFailures: XlsxRowFailure[] = bulk.failures.map((f) => {
        const survivor = parsed.survivors[f.index];
        return {
          xlsxRow: survivor?.xlsxRow ?? -1,
          code: f.code,
          category: f.category,
          reason: f.reason || CATEGORY_REASON_ES[f.category],
        };
      });

      const allFailures = [...parsed.failures, ...xlsxFailures].sort(
        (a, b) => a.xlsxRow - b.xlsxRow,
      );

      const categoryCounts: Record<BulkFailureCategory, number> = {
        length_out_of_range: 0,
        invalid_chars: 0,
        duplicate_in_file: 0,
        already_exists: 0,
        other: 0,
      };
      for (const f of allFailures) categoryCounts[f.category] += 1;

      let errorsFile: BulkXlsxCreateResponse['errorsFile'] = null;
      if (allFailures.length > 0) {
        const errBuf = await buildXlsxErrorsWorkbook(allFailures);
        const baseName = body.fileName.replace(/\.xlsx$/i, '') || 'carga-marbetes';
        errorsFile = {
          fileName: `errores-${baseName}.xlsx`,
          contentBase64: errBuf.toString('base64'),
        };
      }

      // Build a single uniform failures array that the UI can iterate:
      // carries both the bulkCreate metadata (index, line, reason) and
      // the xlsx-only row number.
      const unifiedFailures: BulkXlsxCreateResponse['failures'] = allFailures.map(
        (f) => ({
          index: f.xlsxRow, // for xlsx, `index` is the 1-based xlsx row
          line: f.xlsxRow,
          xlsxRow: f.xlsxRow,
          code: f.code,
          reason: f.reason,
          category: f.category,
        }),
      );

      // successes order matches bulkCreate's order which matches the
      // survivors order (xlsx row order). The xlsx row for a success is
      // the survivor at the same offset.
      const unifiedSuccesses = bulk.successes.map((s, idx) => ({
        id: s.id,
        publicUid: s.publicUid,
        status: s.status,
        xlsxRow: parsed.survivors[idx]?.xlsxRow ?? -1,
      }));

      reply.header('cache-control', 'no-store');
      return {
        ...bulk,
        // bulkCreate only knows about the parsed survivors; the parser-
        // level failures (invalid_chars, duplicate_in_file, ...) live
        // outside its totals. Recompute the row-level counters over ALL
        // registered rows so the summary line ("M errores encontrados de
        // N filas registradas") is truthful.
        total: parsed.survivors.length + allFailures.length,
        created: bulk.created,
        failed: allFailures.length,
        successes: unifiedSuccesses,
        failures: unifiedFailures,
        skippedExampleRows: parsed.skippedExampleRows,
        categoryCounts,
        errorsFile,
      };
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/v1/marbetes/:id',
    { preHandler: requireRole('admin') },
    async (req) => {
      const { id } = MarbeteIdParam.parse(req.params);
      const body = UpdateMarbeteRequest.parse(req.body);
      const actor = actorFromRequest(req);
      const otp = otpFromRequest(req);
      const meta = metaFromRequest(req);
      const svc = getService();
      return svc.update(actor, id, body, otp, meta);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/marbetes/:id',
    { preHandler: requireRole('admin') },
    async (req) => {
      const { id } = MarbeteIdParam.parse(req.params);
      const body = DeleteMarbeteRequest.parse(req.body ?? {});
      const actor = actorFromRequest(req);
      const otp = otpFromRequest(req);
      const meta = metaFromRequest(req);
      const svc = getService();
      return svc.delete(actor, id, body, otp, meta);
    },
  );

  // WU #1: admin-only audit read that returns the unmasked publicUid.
  // Mutates nothing in the marbetes table; only writes an audit_log entry.
  app.post<{ Params: { id: string } }>(
    '/api/v1/marbetes/:id/reveal',
    { preHandler: requireRole('admin') },
    async (req) => {
      const { id } = MarbeteIdParam.parse(req.params);
      const body = RevealMarbeteRequest.parse(req.body);
      const actor = actorFromRequest(req);
      const otp = otpFromRequest(req);
      const meta = metaFromRequest(req);
      const svc = getService();
      return svc.reveal(actor, id, body, otp, meta);
    },
  );
}
