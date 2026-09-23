/**
 * Fastify plugin: Redis client.
 *
 * Same lazy-resilience posture as the pg plugin: connection failure at boot
 * is logged but not thrown; app.redis.healthy() reports current status for
 * /readyz.
 */
import Redis from 'ioredis';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    redis: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string, ttlSeconds?: number): Promise<'OK'>;
      del(key: string): Promise<number>;
      incr(key: string): Promise<number>;
      expire(key: string, ttlSeconds: number): Promise<number>;
      healthy(): Promise<boolean>;
    };
  }
}

async function plugin(app: FastifyInstance): Promise<void> {
  const url = app.config.REDIS_URL;

  const client = new Redis(url, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });

  client.on('error', (err) => app.log.warn({ err: err.message }, 'redis-error'));

  // Best-effort startup ping.
  try {
    await client.ping();
    app.log.info('redis_connected');
  } catch (err) {
    app.log.warn(
      { err: (err as Error).message },
      'redis_connect_failed_at_boot_retrying_lazily',
    );
  }

  const get = async (key: string): Promise<string | null> => client.get(key);
  const set = async (key: string, value: string, ttl?: number): Promise<'OK'> => {
    if (ttl && ttl > 0) {
      return (await client.set(key, value, 'EX', ttl)) as 'OK';
    }
    return (await client.set(key, value)) as 'OK';
  };
  const del = async (key: string): Promise<number> => client.del(key);
  const incr = async (key: string): Promise<number> => client.incr(key);
  const expire = async (key: string, ttlSeconds: number): Promise<number> =>
    client.expire(key, ttlSeconds);
  const healthy = async (): Promise<boolean> => {
    try {
      const r = await client.ping();
      return r === 'PONG';
    } catch {
      return false;
    }
  };

  app.decorate('redis', { get, set, del, incr, expire, healthy });

  app.addHook('onClose', async () => {
    await client.quit().catch((err) => app.log.error({ err: err.message }, 'redis_close_failed'));
  });
}

export default fp(plugin, { name: 'redis' });
