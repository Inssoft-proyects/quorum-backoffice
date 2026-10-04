/**
 * Dispositivos REST routes (prefix /api/v1/dispositivos).
 *
 * Mirrors routes/marbetes.ts:
 *   - OTP enforced on POST/PATCH/DELETE via X-OTP-Code header
 *   - Every destructive op emits an audit_log entry (via AuditService)
 *   - DELETE = soft-revoke (sets status='revoked', revoked_at=now(), reason)
 *
 * Auth (WU6) replaces `x-test-actor` with `req.session.user.id`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CreateDispositivoRequest,
  DeleteDispositivoRequest,
  DispositivoIdParam,
  ListDispositivosFilter,
  UpdateDispositivoRequest,
} from '@quorum-backoffice/shared';
import { DispositivosService } from '../services/dispositivos-service';
import { OtpClient } from '../services/otp-client';
import { requireSession, requireRole } from '../plugins/rbac';

/**
 * B2c / body shape for POST /api/v1/dispositivos/:id/assign.
 * Local schema (not in shared) because the endpoint is internal admin
 * surface only and the service still owns the Canvas-id → internal-id
 * resolution. Shared stays dependency-free.
 */
const AssignDispositivoRequest = z.object({
  canvasUserId: z.number().int().positive(),
});

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

export async function registerDispositivosRoutes(app: FastifyInstance): Promise<void> {
  // B7a (P5.1): the HMAC service identity MUST be the operator-configured
  // OTP_SERVICE_NAME (default 'quorum-backoffice'). Before this fix the
  // inline OtpClient fell back to the constructor default and signed every
  // destructive dispositivos operation as 'quorum-backoffice' even when
  // the operator registered a different name on the quorum-otp side.
  const otp = new OtpClient({
    baseUrl: app.config.OTP_SERVICE_URL,
    serviceToken: app.config.OTP_SERVICE_TOKEN,
    serviceName: app.config.OTP_SERVICE_NAME,
  });

  const getService = (): DispositivosService =>
    new DispositivosService({
      pool: app.pg as unknown as import('pg').Pool,
      log: app.log,
      otp,
    });

  app.get('/api/v1/dispositivos', { preHandler: requireSession() }, async (req) => {
    const filter = ListDispositivosFilter.parse(req.query);
    const svc = getService();
    return svc.list(filter);
  });

  app.get<{ Params: { id: string } }>(
    '/api/v1/dispositivos/:id',
    { preHandler: requireSession() },
    async (req, reply) => {
      const { id } = DispositivoIdParam.parse(req.params);
      const svc = getService();
      const detail = await svc.detail(id);
      reply.header('cache-control', 'no-store');
      return detail;
    },
  );

  app.post(
    '/api/v1/dispositivos',
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const body = CreateDispositivoRequest.parse(req.body);
      const actor = actorFromRequest(req);
      const otpCode = otpFromRequest(req);
      const meta = metaFromRequest(req);
      const svc = getService();
      const created = await svc.create(actor, body, otpCode, meta);
      reply.status(201);
      reply.header('location', `/api/v1/dispositivos/${created.id}`);
      return created;
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/v1/dispositivos/:id',
    { preHandler: requireRole('admin') },
    async (req) => {
      const { id } = DispositivoIdParam.parse(req.params);
      const body = UpdateDispositivoRequest.parse(req.body);
      const actor = actorFromRequest(req);
      const otpCode = otpFromRequest(req);
      const meta = metaFromRequest(req);
      const svc = getService();
      return svc.update(actor, id, body, otpCode, meta);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/dispositivos/:id',
    { preHandler: requireRole('admin') },
    async (req) => {
      const { id } = DispositivoIdParam.parse(req.params);
      const body = DeleteDispositivoRequest.parse(req.body ?? {});
      const actor = actorFromRequest(req);
      const otpCode = otpFromRequest(req);
      const meta = metaFromRequest(req);
      const svc = getService();
      return svc.revoke(actor, id, body, otpCode, meta);
    },
  );

  // B2c / Admin-only, OTP-gated bind of a device to a Canvas student.
  // Fail-closed semantics live in DispositivosService.assign: 404 unknown
  // device, 409 revoked device, 422 missing/inactive student, and a
  // before/after audit entry for every successful (re)assignment.
  app.post<{ Params: { id: string } }>(
    '/api/v1/dispositivos/:id/assign',
    { preHandler: requireRole('admin') },
    async (req) => {
      const { id } = DispositivoIdParam.parse(req.params);
      const body = AssignDispositivoRequest.parse(req.body ?? {});
      const actor = actorFromRequest(req);
      const otpCode = otpFromRequest(req);
      const meta = metaFromRequest(req);
      const svc = getService();
      return svc.assign(actor, id, body, otpCode, meta);
    },
  );

  // B2c / Admin-only, OTP-gated release of a device owner. No body
  // required: the device id alone identifies the active service.
  // Rejects a no-op unassign with 409 so admins cannot burn an OTP
  // without a state change.
  app.post<{ Params: { id: string } }>(
    '/api/v1/dispositivos/:id/unassign',
    { preHandler: requireRole('admin') },
    async (req) => {
      const { id } = DispositivoIdParam.parse(req.params);
      const actor = actorFromRequest(req);
      const otpCode = otpFromRequest(req);
      const meta = metaFromRequest(req);
      const svc = getService();
      return svc.unassign(actor, id, otpCode, meta);
    },
  );
}