/**
 * RBAC preHandler factories.
 *
 * Pure factory functions — no Fastify plugin needed. Each one returns
 * an async preHandler that the route declares in its options:
 *
 *   app.get('/api/v1/...', { preHandler: requireSession() }, handler);
 *   app.post('/api/v1/...', { preHandler: requireRole('admin') }, handler);
 *
 * Role hierarchy is operator=1, auditor=2, admin=3 (from
 * @quorum-backoffice/shared/ROLE_HIERARCHY). `hasAtLeastRole` already
 * implements the comparisons, so e.g. admin satisfies auditor.
 */
import type { FastifyRequest } from 'fastify';
import type { UserRole } from '@quorum-backoffice/shared';
import { hasAtLeastRole } from '@quorum-backoffice/shared';
import { AppError } from '../lib/errors';

/**
 * Require an authenticated session. Use on any route that should only
 * be reachable by a logged-in user. Returns 401 when there is no user
 * on the request (no cookie, expired cookie, or x-test-actor shim
 * absent).
 */
export function requireSession() {
  return async (req: FastifyRequest): Promise<void> => {
    if (!req.session?.user) {
      throw new AppError('unauthorized', 'authentication required', 401);
    }
  };
}

/**
 * Require a session whose role is at least `minRole` per the hierarchy
 * operator=1, auditor=2, admin=3. 401 if no session, 403 if too low.
 */
export function requireRole(minRole: UserRole) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!req.session?.user) {
      throw new AppError('unauthorized', 'authentication required', 401);
    }
    if (!hasAtLeastRole(req.session.user.role, minRole)) {
      throw new AppError(
        'forbidden',
        `role '${minRole}' required`,
        403,
        { actual: req.session.user.role, required: minRole },
      );
    }
  };
}
