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
import {
  CreateDispositivoRequest,
  DeleteDispositivoRequest,
  DispositivoIdParam,
  ListDispositivosFilter,
  UpdateDispositivoRequest,
} from '@quorum-backoffice/shared';
import { DispositivosService } from '../services/dispositivos-service';
import { OtpClient } from '../services/otp-client';

function actorFromRequest(req: FastifyRequest): string {
  const headerActor = req.headers['x-test-actor'];
  if (typeof headerActor === 'string' && headerActor.length > 0) return headerActor;
  return 'dev-user';
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
  const otp = new OtpClient({
    baseUrl: app.config.OTP_SERVICE_URL,
    serviceToken: app.config.OTP_SERVICE_TOKEN,
  });

  const getService = (): DispositivosService =>
    new DispositivosService({
      pool: app.pg as unknown as import('pg').Pool,
      log: app.log,
      otp,
    });

  app.get('/api/v1/dispositivos', async (req) => {
    const filter = ListDispositivosFilter.parse(req.query);
    const svc = getService();
    return svc.list(filter);
  });

  app.get<{ Params: { id: string } }>('/api/v1/dispositivos/:id', async (req, reply) => {
    const { id } = DispositivoIdParam.parse(req.params);
    const svc = getService();
    const detail = await svc.detail(id);
    reply.header('cache-control', 'no-store');
    return detail;
  });

  app.post('/api/v1/dispositivos', async (req, reply) => {
    const body = CreateDispositivoRequest.parse(req.body);
    const actor = actorFromRequest(req);
    const otpCode = otpFromRequest(req);
    const meta = metaFromRequest(req);
    const svc = getService();
    const created = await svc.create(actor, body, otpCode, meta);
    reply.status(201);
    reply.header('location', `/api/v1/dispositivos/${created.id}`);
    return created;
  });

  app.patch<{ Params: { id: string } }>('/api/v1/dispositivos/:id', async (req) => {
    const { id } = DispositivoIdParam.parse(req.params);
    const body = UpdateDispositivoRequest.parse(req.body);
    const actor = actorFromRequest(req);
    const otpCode = otpFromRequest(req);
    const meta = metaFromRequest(req);
    const svc = getService();
    return svc.update(actor, id, body, otpCode, meta);
  });

  app.delete<{ Params: { id: string } }>('/api/v1/dispositivos/:id', async (req) => {
    const { id } = DispositivoIdParam.parse(req.params);
    const body = DeleteDispositivoRequest.parse(req.body ?? {});
    const actor = actorFromRequest(req);
    const otpCode = otpFromRequest(req);
    const meta = metaFromRequest(req);
    const svc = getService();
    return svc.revoke(actor, id, body, otpCode, meta);
  });
}