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
      /**
       * Atomic read-and-delete (`GETDEL` in Redis 6.2+). Returns
       * the value before deletion, or `null` if the key was
       * missing. Used by the M3 `/api/v1/mfa/consume` endpoint
       * to enforce single-use tokens without a separate
       * read+del pair (which would race under concurrency).
       */
      getdel(key: string): Promise<string | null>;
      set(key: string, value: string, ttlSeconds?: number): Promise<'OK'>;
      del(key: string): Promise<number>;
      incr(key: string): Promise<number>;
      expire(key: string, ttlSeconds: number): Promise<number>;
      /**
       * Returns the remaining TTL in seconds for the given key
       * (Redis `TTL` command). -1 if the key has no TTL,
       * -2 if the key does not exist. Used by the M3
       * integration test to assert the redirect-token key has
       * a 30-second TTL immediately after issue.
       */
      ttl(key: string): Promise<number>;
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
  // GETDEL is atomic at the Redis level: ioredis forwards the
  // command and the server performs the read + delete in a
  // single round-trip. Two concurrent /consume calls for the
  // same token will see exactly one winner (the value) and
  // one loser (null). The `client` typing in ioredis does
  // NOT expose `getdel` directly under our tsconfig's
  // `lib: ['ES2022', 'DOM']` shape, so we narrow it through
  // an `as unknown as { getdel(...): ... }` cast to call the
  // method without losing the ioredis `Redis` instance's
  // other capabilities (event listeners, retry strategy, …).
  const getdel = async (key: string): Promise<string | null> =>
    (client as unknown as { getdel(k: string): Promise<string | null> }).getdel(key);
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
  const ttl = async (key: string): Promise<number> => client.ttl(key);
  const healthy = async (): Promise<boolean> => {
    try {
      const r = await client.ping();
      return r === 'PONG';
    } catch {
      return false;
    }
  };

  app.decorate('redis', { get, getdel, set, del, incr, expire, ttl, healthy });

  app.addHook('onClose', async () => {
    await client.quit().catch((err) => app.log.error({ err: err.message }, 'redis_close_failed'));
  });
}

export default fp(plugin, { name: 'redis' });
