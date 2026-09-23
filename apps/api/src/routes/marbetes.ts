/**
 * Marbetes REST routes (prefix /api/v1/marbetes).
 *
 * WU3b:
 *   - OTP is enforced on POST/PATCH/DELETE via X-OTP-Code header
 *   - Every destructive op also emits an audit_log entry (via AuditService)
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
} from '@quorum-backoffice/shared';
import { MarbetesService } from '../services/marbetes-service';
import { OtpClient } from '../services/otp-client';
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

  const getService = (): MarbetesService =>
    new MarbetesService({
      pool: app.pg as unknown as import('pg').Pool,
      log: app.log,
      otp,
    });

  app.get('/api/v1/marbetes/counters', { preHandler: requireSession() }, async () => {
    const svc = getService();
    return svc.counters();
  });

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
