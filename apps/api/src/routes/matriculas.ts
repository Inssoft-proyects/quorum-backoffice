/**
 * Matrículas REST routes (prefix /api/v1/matriculas).
 *
 *   - GET /api/v1/matriculas            — paginated listing (session)
 *   - GET /api/v1/matriculas/counters   — header counters (session)
 *   - POST /api/v1/matriculas/assign    — bulk assign (admin, OTP)
 *   - POST /api/v1/matriculas/unassign  — single unassign (admin, OTP)
 *   - POST /api/v1/matriculas/sync      — Canvas → cache (admin, NO OTP)
 *
 * Reads are session-gated (any authenticated operator can browse).
 * Writes require admin role; assign + unassign go through the same
 * 20-minute OTP grant window as the destructive marbete endpoints
 * (scope family `marbete.update` so one OTP covers both operations).
 *
 * Sync is deliberately OTP-free: the call is read-only toward the
 * upstream portal-api and only writes to our local cache, which is
 * already covered by the rate-limit + admin-role gate.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AssignMarbetesRequest,
  ListMatriculasFilter,
  UnassignMarbeteRequest,
  type ListMatriculasResponse,
  type MatriculasCountersResponse,
  type SyncMatriculasResponse,
} from '@quorum-backoffice/shared';
import { MatriculasService } from '../services/matriculas-service';
import { OtpClient } from '../services/otp-client';
import { OtpGrantService } from '../services/otp-grant-service';
import { CanvasClient } from '../services/canvas-client';
import { requireRole, requireSession } from '../plugins/rbac';

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

export async function registerMatriculasRoutes(app: FastifyInstance): Promise<void> {
  const otp = new OtpClient({
    baseUrl: app.config.OTP_SERVICE_URL,
    serviceToken: app.config.OTP_SERVICE_TOKEN,
  });
  const grantTtlMs = app.config.OTP_GRANT_TTL_MINUTES * 60 * 1000;
  const grant = new OtpGrantService(app.pg as unknown as import('pg').Pool, {
    ttlMs: grantTtlMs,
  });
  const canvas = new CanvasClient({
    baseUrl: app.config.CANVAS_PORTAL_API_URL,
    serviceToken: app.config.CANVAS_PORTAL_API_TOKEN,
  });

  const getService = (): MatriculasService =>
    new MatriculasService({
      pool: app.pg as unknown as import('pg').Pool,
      log: app.log,
      otp,
      grant,
      canvas,
    });

  // List: session-gated read. Cache-Control: no-store because the
  // join reflects the latest Canvas sync + grant cache state.
  app.get<{ Reply: ListMatriculasResponse }>(
    '/api/v1/matriculas',
    { preHandler: requireSession() },
    async (req, reply) => {
      const filter = ListMatriculasFilter.parse(req.query);
      const svc = getService();
      reply.header('cache-control', 'no-store');
      return svc.list(filter);
    },
  );

  // Counters: header aggregates for the screen layout.
  app.get<{ Reply: MatriculasCountersResponse }>(
    '/api/v1/matriculas/counters',
    { preHandler: requireSession() },
    async (req, reply) => {
      const filter = ListMatriculasFilter.parse(req.query);
      const svc = getService();
      reply.header('cache-control', 'no-store');
      return svc.counters(filter);
    },
  );

  // Bulk assign: admin-only + OTP (or active grant). The service
  // validates every pair and rolls back on the first violation.
  app.post(
    '/api/v1/matriculas/assign',
    { preHandler: requireRole('admin') },
    async (req) => {
      const body = AssignMarbetesRequest.parse(req.body);
      const actor = actorFromRequest(req);
      const otpCode = otpFromRequest(req);
      const meta = metaFromRequest(req);
      const svc = getService();
      return svc.assignBulk(actor, body, otpCode, meta);
    },
  );

  // Single unassign: admin-only + OTP (or active grant).
  app.post(
    '/api/v1/matriculas/unassign',
    { preHandler: requireRole('admin') },
    async (req) => {
      const body = UnassignMarbeteRequest.parse(req.body);
      const actor = actorFromRequest(req);
      const otpCode = otpFromRequest(req);
      const meta = metaFromRequest(req);
      const svc = getService();
      return svc.unassign(actor, body, otpCode, meta);
    },
  );

  // Sync: admin-only, no OTP (read-only toward Canvas).
  app.post<{ Reply: SyncMatriculasResponse }>(
    '/api/v1/matriculas/sync',
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const actor = actorFromRequest(req);
      const meta = metaFromRequest(req);
      const svc = getService();
      reply.header('cache-control', 'no-store');
      return svc.sync(actor, meta);
    },
  );
}