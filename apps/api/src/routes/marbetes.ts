/**
 * Marbetes REST routes (prefix /api/v1/marbetes).
 *
 * WU3a scope:
 *   - GET /                list with filter
 *   - GET /counters        OK/KO counters
 *   - GET /:id             detail (with masked code + resolved student)
 *   - POST /               create
 *   - PATCH /:id           update (assign/reassign)
 *   - DELETE /:id          soft-delete with reason
 *
 * Auth: every route requires a session. WU3b reads `req.session.actor`;
 * WU3a uses a placeholder actor pulled from header `x-test-actor`.
 * OTP: WU3b enforces; WU3a accepts an optional `otpCode` but ignores it.
 */
import type { FastifyInstance } from 'fastify';
import {
  CreateMarbeteRequest,
  DeleteMarbeteRequest,
  ListMarbetesFilter,
  MarbeteIdParam,
  UpdateMarbeteRequest,
} from '@quorum-backoffice/shared';
import { MarbetesService } from '../services/marbetes-service';

function actorFromRequest(req: import('fastify').FastifyRequest): string {
  // WU6 replaces this with req.session.user.id; WU3a reads a dev-only header.
  const headerActor = req.headers['x-test-actor'];
  if (typeof headerActor === 'string' && headerActor.length > 0) return headerActor;
  return 'dev-user';
}

function otpFromRequest(req: import('fastify').FastifyRequest): string | undefined {
  const otpHeader = req.headers['x-otp-code'];
  return typeof otpHeader === 'string' && otpHeader.length > 0 ? otpHeader : undefined;
}

export async function registerMarbetesRoutes(app: FastifyInstance): Promise<void> {
  const getService = (): MarbetesService =>
    new MarbetesService({ pool: app.pg as unknown as import('pg').Pool, log: app.log });

  // ---- GET /api/v1/marbetes/counters ----
  app.get('/api/v1/marbetes/counters', async () => {
    const svc = getService();
    return svc.counters();
  });

  // ---- GET /api/v1/marbetes ----
  app.get('/api/v1/marbetes', async (req) => {
    const filter = ListMarbetesFilter.parse(req.query);
    const svc = getService();
    return svc.list(filter);
  });

  // ---- GET /api/v1/marbetes/:id ----
  app.get<{ Params: { id: string } }>('/api/v1/marbetes/:id', async (req, reply) => {
    const { id } = MarbeteIdParam.parse(req.params);
    const svc = getService();
    const detail = await svc.detail(id);
    reply.header('cache-control', 'no-store');
    return detail;
  });

  // ---- POST /api/v1/marbetes ----
  app.post('/api/v1/marbetes', async (req, reply) => {
    const body = CreateMarbeteRequest.parse(req.body);
    const actor = actorFromRequest(req);
    const otp = otpFromRequest(req);
    const svc = getService();
    const created = await svc.create(actor, body, otp);
    reply.status(201);
    reply.header('location', `/api/v1/marbetes/${created.id}`);
    return created;
  });

  // ---- PATCH /api/v1/marbetes/:id ----
  app.patch<{ Params: { id: string } }>('/api/v1/marbetes/:id', async (req) => {
    const { id } = MarbeteIdParam.parse(req.params);
    const body = UpdateMarbeteRequest.parse(req.body);
    const actor = actorFromRequest(req);
    const otp = otpFromRequest(req);
    const svc = getService();
    return svc.update(actor, id, body, otp);
  });

  // ---- DELETE /api/v1/marbetes/:id ----
  app.delete<{ Params: { id: string } }>('/api/v1/marbetes/:id', async (req) => {
    const { id } = MarbeteIdParam.parse(req.params);
    const body = DeleteMarbeteRequest.parse(req.body ?? {});
    const actor = actorFromRequest(req);
    const otp = otpFromRequest(req);
    const svc = getService();
    return svc.delete(actor, id, body, otp);
  });
}
