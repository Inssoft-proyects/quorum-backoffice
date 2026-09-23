/**
 * WU0 integration smoke — verifies /healthz and /readyz against real PG + Redis.
 *
 * Requires `bash scripts/dev-bootstrap.sh` to have run successfully so the
 * local quorum_backoffice and quorum_backoffice_test databases exist with
 * pgcrypto, and Redis is reachable on 127.0.0.1:6379.
 */
import { buildApp } from '../../src/app';

const TEST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  API_PORT: '3099',
  API_HOST: '127.0.0.1',
  DATABASE_URL:
    process.env['DATABASE_URL_TEST'] ??
    'postgresql://websop:quorum_backoffice_dev@127.0.0.1:5432/quorum_backoffice_test',
  REDIS_URL: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
  OTP_SERVICE_URL: process.env['OTP_SERVICE_URL'] ?? 'http://127.0.0.1:65535',
  OTP_SERVICE_TOKEN: process.env['OTP_SERVICE_TOKEN'] ?? 'test-otp-token-1234567890',
  CANVAS_PORTAL_API_URL: process.env['CANVAS_PORTAL_API_URL'] ?? 'http://127.0.0.1:65535',
  CANVAS_PORTAL_API_TOKEN:
    process.env['CANVAS_PORTAL_API_TOKEN'] ?? 'test-canvas-token-1234567890',
  SESSION_SECRET: process.env['SESSION_SECRET'] ?? 'a'.repeat(64),
  SESSION_TTL_SECONDS: '3600',
};

describe('health endpoints (integration, real PG + Redis)', () => {
  it('GET /healthz returns 200', async () => {
    const app = await buildApp({ config: TEST_ENV });
    try {
      const r = await app.inject({ method: 'GET', url: '/healthz' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ status: 'ok' });
    } finally {
      await app.close();
    }
  });

  it('GET /readyz returns 200 when both services are up', async () => {
    const app = await buildApp({ config: TEST_ENV });
    try {
      const r = await app.inject({ method: 'GET', url: '/readyz' });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { status: string; checks: { pg: string; redis: string; otp: string } };
      expect(body.status).toBe('ok');
      expect(body.checks.pg).toBe('ok');
      expect(body.checks.redis).toBe('ok');
      expect(body.checks.otp).toMatch(/^(ok|down|unknown)$/);
    } finally {
      await app.close();
    }
  });
});
