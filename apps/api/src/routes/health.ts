/**
 * Health and readiness endpoints.
 *
 *   GET /healthz — liveness (always 200 if process alive)
 *   GET /readyz  — readiness (200 only if PG + Redis reachable)
 *   GET /metrics — Prometheus exposition
 */
// (FastifyInstance type intentionally omitted; the inline import is used elsewhere)

export async function registerHealthRoutes(app: import("fastify").FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    const [pgOk, redisOk] = await Promise.all([app.pg.healthy(), app.redis.healthy()]);
    const ready = pgOk && redisOk;
    reply.status(ready ? 200 : 503);
    return {
      status: ready ? 'ready' : 'degraded',
      checks: { postgres: pgOk ? 'up' : 'down', redis: redisOk ? 'up' : 'down' },
    };
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', app.metrics.registry.contentType);
    return app.metrics.registry.metrics();
  });
}
