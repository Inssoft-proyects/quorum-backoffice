/**
 * Tiny custom migration runner.
 *
 * Tracks applied migrations in `_migrations(filename, applied_at)`. Each
 * migration file is run inside a single transaction. Re-applying a migration
 * is a no-op (idempotent). Designed for sibling projects that don't want
 * Prisma/knex/etc.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';

export interface MigrationRow {
  filename: string;
  applied_at: Date;
}

export interface MigrationLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
}

export async function ensureMigrationsTable(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename    TEXT        PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export async function listApplied(pool: pg.Pool): Promise<Set<string>> {
  const r = await pool.query<MigrationRow>('SELECT filename, applied_at FROM _migrations');
  return new Set(r.rows.map((row) => row.filename));
}

export async function listMigrationFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort();
}

export interface MigrateOptions {
  pool: pg.Pool;
  dir: string;
  logger?: MigrationLogger;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

const noopLogger: MigrationLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export async function migrate(opts: MigrateOptions): Promise<MigrateResult> {
  const log = opts.logger ?? noopLogger;
  const result: MigrateResult = { applied: [], skipped: [] };

  await ensureMigrationsTable(opts.pool);
  const applied = await listApplied(opts.pool);
  const files = await listMigrationFiles(opts.dir);

  for (const filename of files) {
    if (applied.has(filename)) {
      result.skipped.push(filename);
      log.info(`skip   ${filename}`);
      continue;
    }
    const sql = await fs.readFile(path.join(opts.dir, filename), 'utf8');
    log.info(`apply  ${filename}`);
    const client = await opts.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      result.applied.push(filename);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      log.error(`failed  ${filename}`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  return result;
}
