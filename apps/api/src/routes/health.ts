/**
 * Health and readiness endpoints.
 *
 *   GET /healthz — liveness (always 200 if process alive)
 *   GET /readyz  — readiness (200 only if PG + Redis reachable; OTP is best-effort)
 *   GET /metrics — Prometheus exposition
 *
 * WU11: /readyz is now a deep check that exercises PG, Redis, and the OTP
 * service in parallel via Promise.allSettled so one slow check never blocks
 * another. The OTP service is best-effort: it is reported as `ok`/`down`/
 * `unknown` but never affects the HTTP status code (only PG and Redis are
 * critical dependencies).
 */
import type { FastifyInstance } from 'fastify';

interface CheckResult {
  pg: 'ok' | 'down';
  redis: 'ok' | 'down';
  otp: 'ok' | 'down' | 'unknown';
}

const OTP_PROBE_TIMEOUT_MS = 2_000;

async function checkPg(app: FastifyInstance): Promise<'ok' | 'down'> {
  try {
    await app.pg.healthy();
    return 'ok';
  } catch {
    return 'down';
  }
}

async function checkRedis(app: FastifyInstance): Promise<'ok' | 'down'> {
  try {
    return (await app.redis.healthy()) ? 'ok' : 'down';
  } catch {
    return 'down';
  }
}

/**
 * Probe OTP service health. Uses `${OTP_SERVICE_URL}/healthz` with a short
 * timeout so a slow/dead OTP service can't drag /readyz past the k8s probe
 * deadline. The probe accepts 200 and 204 as "up" (some services use 204 for
 * a header-only liveness response).
 *
 *   - No OTP_SERVICE_URL configured → 'unknown' (defensive; in practice the
 *     config schema requires it, but we keep this branch for safety).
 *   - 2xx within the timeout → 'ok'
 *   - Non-2xx, network error, timeout, or abort → 'down'
 */
async function checkOtp(app: FastifyInstance): Promise<'ok' | 'down' | 'unknown'> {
  const baseUrl = app.config.OTP_SERVICE_URL;
  if (!baseUrl) return 'unknown';

  const url = `${baseUrl.replace(/\/+$/, '')}/healthz`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), OTP_PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: ac.signal,
    });
    if (r.status === 200 || r.status === 204) return 'ok';
    return 'down';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    // Run all three checks in parallel; Promise.allSettled guarantees one
    // rejection never short-circuits the rest, so a slow OTP service can't
    // stretch the response past the k8s readiness deadline.
    const [pgSettled, redisSettled, otpSettled] = await Promise.allSettled([
      checkPg(app),
      checkRedis(app),
      checkOtp(app),
    ]);

    const pg = pgSettled.status === 'fulfilled' ? pgSettled.value : 'down';
    const redis = redisSettled.status === 'fulfilled' ? redisSettled.value : 'down';
    const otp = otpSettled.status === 'fulfilled' ? otpSettled.value : 'down';

    const checks: CheckResult = { pg, redis, otp };
    const criticalUp = pg === 'ok' && redis === 'ok';

    reply.status(criticalUp ? 200 : 503);
    return {
      status: criticalUp ? 'ok' : 'degraded',
      checks,
    };
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', app.metrics.registry.contentType);
    return app.metrics.registry.metrics();
  });
}
