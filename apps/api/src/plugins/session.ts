/**
 * Fastify plugin: session hydration.
 *
 * Decorates `FastifyRequest.session` with `{ user, source }` for every
 * request before any handler runs. Three sources, checked in order:
 *
 *   1. `x-test-actor` header — virtual admin, used by the existing
 *      marbetes/dispositivos/audit integration tests so they don't
 *      need to perform a real login. Kept as a back-compat shim.
 *   2. The session cookie (real session lookup via SessionHydrator).
 *   3. Neither — `session.user = null`.
 *
 * The cookie is read via `@fastify/cookie` (already registered in
 * `app.ts`). The token shape is validated by `isValidSessionToken` so
 * a malformed cookie value is treated as "no session" rather than a DB
 * round-trip.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { MeResponse, UserRole } from '@quorum-backoffice/shared';
import { isValidSessionToken } from '../lib/session-token';
import { SessionHydrator } from '../lib/session-hydrator';

declare module 'fastify' {
  interface FastifyRequest {
    session: {
      user: MeResponse | null;
      source: 'cookie' | 'test-actor' | 'none';
    };
  }
}

async function plugin(app: FastifyInstance): Promise<void> {
  // Decorate first so handlers can read req.session before onRequest fires.
  // Fastify v5 rejects object-typed defaults for reference types ("use
  // { getter, setter } instead"). Cast through unknown so the runtime
  // value is null and TS is happy — the onRequest hook below always
  // overwrites it before any handler runs.
  app.decorateRequest('session', null as unknown as never);

  const hydrator = new SessionHydrator(app.pg as unknown as import('pg').Pool);
  const cookieName = app.config.AUTH_COOKIE_NAME;

  app.addHook('onRequest', async (req) => {
    // Test shim: x-test-actor is treated as a virtual admin. Used by
    // the existing marbetes/dispositivos/audit tests so they don't
    // need to perform a real login.
    const testActor = req.headers['x-test-actor'];
    if (typeof testActor === 'string' && testActor.length > 0) {
      req.session = {
        user: { id: 0, email: testActor, role: 'admin' as UserRole },
        source: 'test-actor',
      };
      return;
    }

    // Cookie-based session lookup.
    const token = req.cookies?.[cookieName];
    if (typeof token !== 'string' || !isValidSessionToken(token)) {
      req.session = { user: null, source: 'none' };
      return;
    }

    const user = await hydrator.resolve(token);
    req.session = { user, source: 'cookie' };
  });
}

export default fp(plugin, {
  name: 'session',
});
