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
  CreateMarbeteRequest,
  DeleteMarbeteRequest,
  ListMarbetesFilter,
  MarbeteIdParam,
  RevealMarbeteRequest,
  UpdateMarbeteRequest,
  type OtpGrantStatusResponse,
} from '@quorum-backoffice/shared';
import { MarbetesService } from '../services/marbetes-service';
import { OtpClient } from '../services/otp-client';
import { OtpGrantService } from '../services/otp-grant-service';
import { requireSession, requireRole } from '../plugins/rbac';
import { parseCsvCodes } from '../lib/marbete-id';

function actorFromRequest(req: FastifyRequest): string {
  return req.session?.user?.email ?? 'dev-user';
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
  const otp = new OtpClient({
    baseUrl: app.config.OTP_SERVICE_URL,
    serviceToken: app.config.OTP_SERVICE_TOKEN,
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
  app.post(
    '/api/v1/marbetes/bulk',
    { preHandler: requireRole('admin') },
    async (req) => {
      const body = BulkCreateMarbetesRequest.parse(req.body);
      const actor = actorFromRequest(req);
      const otp = otpFromRequest(req);
      const meta = metaFromRequest(req);
      const svc = getService();
      return svc.bulkCreate(actor, body, 'json', null, otp, meta);
    },
  );

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
