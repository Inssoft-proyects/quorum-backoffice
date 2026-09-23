/**
 * Students REST routes (prefix /api/v1/students).
 *
 *   GET /api/v1/students?canvasUserId=<number>  → StudentDetailResponse | 404
 *
 * Read-only surface: resolved against the students_cache read-through
 * table. Returns 404 when the canvas_user_id is not in cache (a Canvas
 * sync is required first). Cache-Control: no-store because the student
 * snapshot may change with the next Canvas sync.
 *
 * Auth (WU6) replaces `x-test-actor` shim with the session user; the
 * preHandler (requireRole('admin')) mirrors the marbetes POST/PATCH
 * permission level — students lookup is needed to assign a marbete.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { StudentsService } from '../services/students-service';
import { requireRole } from '../plugins/rbac';

const StudentsQuery = z.object({
  canvasUserId: z.coerce.number().int().positive(),
});
type StudentsQuery = z.infer<typeof StudentsQuery>;

export async function registerStudentsRoutes(app: FastifyInstance): Promise<void> {
  const getService = (): StudentsService =>
    new StudentsService({ pool: app.pg as unknown as import('pg').Pool });

  app.get(
    '/api/v1/students',
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const q = StudentsQuery.parse(req.query);
      const svc = getService();
      const detail = await svc.findByCanvasId(q.canvasUserId);
      reply.header('cache-control', 'no-store');
      return detail;
    },
  );
}
