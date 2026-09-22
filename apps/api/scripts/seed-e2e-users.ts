#!/usr/bin/env tsx
/**
 * CLI: idempotent seed of the three E2E users used by apps/web playwright tests.
 *
 * Defaults match the credentials expected by apps/web/e2e/auth.spec.ts:
 *   - admin@quorum.local    / admin1234    / role admin
 *   - operator@quorum.local / operator1234 / role operator
 *   - auditor@quorum.local  / auditor1234  / role auditor
 *
 * Each email + password can be overridden via env vars:
 *   E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD
 *   E2E_OPERATOR_EMAIL, E2E_OPERATOR_PASSWORD
 *   E2E_AUDITOR_EMAIL, E2E_AUDITOR_PASSWORD
 *
 * Idempotent: re-running upserts each user with a fresh bcrypt hash
 * (cost 12, same as AuthService.verifyPassword). Safe to run before
 * every Playwright session.
 *
 * Usage:
 *   cd apps/api && npm run seed:e2e
 */
import { loadConfig } from '../src/config';
import { createLogger } from '../src/lib/logger';
import { Pool } from 'pg';
import bcrypt from 'bcrypt';

interface SeedUser {
  email: string;
  password: string;
  role: 'admin' | 'operator' | 'auditor';
}

const DEFAULT_USERS: SeedUser[] = [
  { email: 'admin@quorum.local',    password: 'admin1234',    role: 'admin' },
  { email: 'operator@quorum.local', password: 'operator1234', role: 'operator' },
  { email: 'auditor@quorum.local',  password: 'auditor1234',  role: 'auditor' },
];

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  if (!config.DATABASE_URL) {
    // eslint-disable-next-line no-console
    console.error('seed_failed: DATABASE_URL is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
  try {
    for (const defaultUser of DEFAULT_USERS) {
      const emailEnvVar = `E2E_${defaultUser.role.toUpperCase()}_EMAIL`;
      const passwordEnvVar = `E2E_${defaultUser.role.toUpperCase()}_PASSWORD`;
      const email = process.env[emailEnvVar] ?? defaultUser.email;
      const password = process.env[passwordEnvVar] ?? defaultUser.password;

      // Bcrypt cost 12 — matches AuthService default (see auth-service.ts).
      const hash = await bcrypt.hash(password, 12);

      const result = await pool.query<{ id: string; inserted: boolean }>(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE
           SET password_hash = EXCLUDED.password_hash,
               role = EXCLUDED.role
         RETURNING id, (xmax = 0) AS inserted`,
        [email, hash, defaultUser.role],
      );

      const row = result.rows[0];
      logger.info(
        { email, role: defaultUser.role, id: row.id, inserted: row.inserted },
        row.inserted ? 'seed_user_created' : 'seed_user_updated',
      );
    }
    logger.info({ count: DEFAULT_USERS.length }, 'seed_done');
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('seed_failed', err);
  process.exit(1);
});