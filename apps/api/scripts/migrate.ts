#!/usr/bin/env tsx
/**
 * CLI: apply all pending migrations against DATABASE_URL.
 *
 * Usage:
 *   npm run migrate            # apply against $DATABASE_URL
 *   DATABASE_URL_TEST=... npm run migrate
 */
import { loadConfig } from '../src/config';
import { createLogger } from '../src/lib/logger';
import { Pool } from 'pg';
import { migrate } from '../src/migrations';
import path from 'node:path';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
  try {
    const dir = path.resolve(__dirname, '..', 'migrations');
    const result = await migrate({ pool, dir, logger: { info: (m) => logger.info(m), warn: (m) => logger.warn(m), error: (m, e) => logger.error({ err: e }, m) } });
    logger.info({ applied: result.applied.length, skipped: result.skipped.length }, 'migrate_done');
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('migrate_failed', err);
  process.exit(1);
});
