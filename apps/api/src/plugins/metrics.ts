/**
 * Fastify plugin: Prometheus metrics.
 *
 * Exposes a registry with default Node process metrics plus custom counters:
 *   - http_requests_total{method,route,status}
 *   - app_info{version}
 *
 * Adds an onResponse hook to increment http_requests_total automatically.
 */
import fp from 'fastify-plugin';
import promClient from 'prom-client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    metrics: {
      registry: promClient.Registry;
      httpRequests: promClient.Counter<string>;
    };
  }
}

async function plugin(app: FastifyInstance): Promise<void> {
  const registry = new promClient.Registry();
  registry.setDefaultLabels({ service: 'quorum-backoffice-api', env: app.config.NODE_ENV });
  promClient.collectDefaultMetrics({ register: registry });

  const httpRequests = new promClient.Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests by method, route, and status code',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });

  const appInfo = new promClient.Gauge({
    name: 'app_info',
    help: 'Static build info',
    labelNames: ['version', 'service'] as const,
    registers: [registry],
  });
  appInfo.labels({ version: '0.1.0', service: 'quorum-backoffice-api' }).set(1);

  app.decorate('metrics', { registry, httpRequests });

  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const route = req.routeOptions?.url ?? req.url;
    httpRequests.inc({
      method: req.method,
      route,
      status: String(reply.statusCode),
    });
  });
}

export default fp(plugin, { name: 'metrics' });
