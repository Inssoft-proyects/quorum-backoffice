/**
 * Build a Fastify instance for the backoffice admin API.
 *
 * Wires:
 *   - helmet + cors + global rate limit
 *   - zod-validated config (via config.ts)
 *   - pino logger (via lib/logger.ts)
 *   - pg + redis plugins
 *   - prom-client metrics plugin
 *   - centralized error handler (lib/errors.ts)
 *   - health routes (/healthz, /readyz, /metrics)
 *
 * Domain routes (auth, marbetes, dispositivos, audit) are added by
 * subsequent WUs (WU3–WU6). Not registering them here keeps WU0 lean.
 */
import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';

import { loadConfig, type Config } from './config';
import { createLogger } from './lib/logger';
import { httpErrorHandler } from './lib/errors';
import pgPlugin from './plugins/pg';
import redisPlugin from './plugins/redis';
import metricsPlugin from './plugins/metrics';
import { registerHealthRoutes } from './routes/health';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}

export async function buildApp(
  overrides?: { config?: NodeJS.ProcessEnv },
): Promise<FastifyInstance> {
  const config = loadConfig(overrides?.config);
  const logger = createLogger(config);

  // loggerInstance widens the type to pino's Logger which is compatible
  // at runtime but differs at the type level; cast through unknown to the
  // base logger shape Fastify expects.
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    trustProxy: true,
    genReqId: () => cryptoRandomUuid(),
  });

  app.decorate('config', config);

  // Security & infra
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: false, credentials: true });
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1'],
  });

  // Domain plugins
  await app.register(metricsPlugin);
  await app.register(pgPlugin);
  await app.register(redisPlugin);

  // Centralized error handler
  app.setErrorHandler(httpErrorHandler);

  // Health & metrics
  await registerHealthRoutes(app as unknown as FastifyInstance);

  return app;
}

function cryptoRandomUuid(): string {
  // Use Node 22's globalThis.crypto.randomUUID if available, else fallback.
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
