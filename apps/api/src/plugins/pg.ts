/**
 * Fastify plugin: PostgreSQL connection pool.
 *
 * Decorates the Fastify instance with:
 *   - app.pg.query<T>(sql, params?) — parameterized SELECT
 *   - app.pg.tx<T>(fn) — run inside a transaction
 *   - app.pg.healthy() — for /readyz
 *
 * The pool opens lazily on first use. A startup ping is best-effort and
 * does NOT throw; an unreachable database is reflected via healthy()=false
 * so /readyz can report the degraded state without killing the process.
 */
import pg from 'pg';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

const { Pool } = pg;

declare module 'fastify' {
  interface FastifyInstance {
    pg: {
      query<T extends pg.QueryResultRow = pg.QueryResultRow>(
        sql: string,
        params?: unknown[],
      ): Promise<pg.QueryResult<T>>;
      tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
      healthy(): Promise<boolean>;
    };
  }
}

async function plugin(app: FastifyInstance): Promise<void> {
  const url = app.config.DATABASE_URL;

  // Parse bigint (8 bytes per id) as number since our row IDs fit in JS Number range.
  // Without this, Fastify's JSON serializer emits them as strings which Zod then
  // rejects on the client side (it expects number for id).
  pg.types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

  const pool = new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (err) => {
    app.log.error({ err: err.message }, 'pg_pool_error');
  });

  // Best-effort startup ping; failure does NOT throw.
  try {
    const probe = await pool.query<{ now: number }>('SELECT now()::int AS now');
    app.log.info({ now: probe.rows[0]?.now }, 'pg_connected');
  } catch (err) {
    app.log.warn(
      { err: (err as Error).message },
      'pg_connect_failed_at_boot_retrying_lazily',
    );
  }

  const query = async <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>> => {
    return pool.query<T>(sql, params as never);
  };

  const tx = async <T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };

  const healthy = async (): Promise<boolean> => {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  };

  app.decorate('pg', { query, tx, healthy });

  app.addHook('onClose', async () => {
    await pool.end().catch((err) => app.log.error({ err: err.message }, 'pg_close_failed'));
  });
}

export default fp(plugin, { name: 'pg' });
