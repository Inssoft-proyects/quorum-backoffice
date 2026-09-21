/**
 * Audit REST routes (prefix /api/v1/audit).
 *
 * Read-only surface for the audit_log table. Mirrors the response shape
 * of dispositivos/marbetes detail endpoints but never enforces OTP — both
 * endpoints are GETs and protected only by the current `x-test-actor`
 * shim until WU6 attaches an `auditor+` RBAC preHandler.
 *
 * Auth (WU6) replaces `x-test-actor` with `req.session.user.id`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ListAuditFilter } from '@quorum-backoffice/shared';
import { AuditQueryService } from '../services/audit-query-service';

// Local path-param schema; mirrors DispositivoIdParam but stays in this
// module to avoid touching the shared DTO package surface.
const AuditIdParam = z.object({
  id: z.coerce.number().int().positive(),
});
type AuditIdParam = z.infer<typeof AuditIdParam>;

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  const getService = (): AuditQueryService =>
    new AuditQueryService({ pool: app.pg as unknown as import('pg').Pool });

  app.get('/api/v1/audit', async (req) => {
    const filter = ListAuditFilter.parse(req.query);
    const svc = getService();
    return svc.list(filter);
  });

  app.get<{ Params: { id: string } }>('/api/v1/audit/:id', async (req, reply) => {
    const { id } = AuditIdParam.parse(req.params);
    const svc = getService();
    const detail = await svc.detail(id);
    reply.header('cache-control', 'no-store');
    return detail;
  });
}
