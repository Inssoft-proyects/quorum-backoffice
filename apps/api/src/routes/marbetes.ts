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
import {
  CreateMarbeteRequest,
  DeleteMarbeteRequest,
  ListMarbetesFilter,
  MarbeteIdParam,
  UpdateMarbeteRequest,
} from '@quorum-backoffice/shared';
import { MarbetesService } from '../services/marbetes-service';
import { OtpClient } from '../services/otp-client';
import { requireSession, requireRole } from '../plugins/rbac';

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
}
