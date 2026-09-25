#!/usr/bin/env tsx
/**
 * CLI: idempotent seed of the three E2E users used by apps/web playwright tests.
 *
 * Defaults match the credentials expected by apps/web/e2e/auth.spec.ts:
 *   - admin@quorum.local    / admin1234    / role admin    / username admin
 *   - operator@quorum.local / operator1234 / role operator / username operator
 *   - auditor@quorum.local  / auditor1234  / role auditor  / username auditor
 *
 * Each email, password, and username can be overridden via env vars:
 *   E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_ADMIN_USERNAME
 *   E2E_OPERATOR_EMAIL, E2E_OPERATOR_PASSWORD, E2E_OPERATOR_USERNAME
 *   E2E_AUDITOR_EMAIL, E2E_AUDITOR_PASSWORD, E2E_AUDITOR_USERNAME
 *
 * Username migration (Polish WU v6 + 0011_backoffice_username):
 *   - The seed assigns a deterministic username per role. Usernames are
 *     NOT derived from the email address (the migration deliberately
 *     does not backfill from email because the canonical BackOffice
 *     username is not always recoverable from the address).
 *   - The password_hash column is kept populated so legacy columns
 *     remain observable, but the single-step username + pre-issued
 *     OTP login never reads it.
 *
 * Idempotent: re-running upserts each user with a fresh bcrypt hash
 * (cost 12, matches AuthService.verifyPassword) and re-asserts the
 * canonical username. Safe to run before every Playwright session.
 *
 * Usage:
 *   cd apps/api && npm run seed:e2e
 */
import { loadConfig } from '../src/config';
import { createLogger } from '../src/lib/logger';
import { Pool } from 'pg';
import bcrypt from 'bcrypt';

interface SeedUser {
  /** BackOffice role; preserved on every upsert. */
  role: 'admin' | 'operator' | 'auditor';
  /** Login email (kept for compatibility with legacy fixtures). */
  email: string;
  /** Legacy password column value; still seeded for column-stability. */
  password: string;
  /**
   * Canonical BackOffice login identifier (migration 0011). Deliberately
   * NOT derived from the email — usernames are assigned per-role here
   * so the same script works against any environment without inferring
   * a production username from a development email.
   */
  username: string;
}

const DEFAULT_USERS: SeedUser[] = [
  { role: 'admin',    email: 'admin@quorum.local',    password: 'admin1234',    username: 'admin' },
  { role: 'operator', email: 'operator@quorum.local', password: 'operator1234', username: 'operator' },
  { role: 'auditor',  email: 'auditor@quorum.local',  password: 'auditor1234',  username: 'auditor' },
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
      const usernameEnvVar = `E2E_${defaultUser.role.toUpperCase()}_USERNAME`;
      const email = process.env[emailEnvVar] ?? defaultUser.email;
      const password = process.env[passwordEnvVar] ?? defaultUser.password;
      const username = process.env[usernameEnvVar] ?? defaultUser.username;

      // Bcrypt cost 12 — matches AuthService default (see auth-service.ts).
      const hash = await bcrypt.hash(password, 12);

      const result = await pool.query<{ id: string; inserted: boolean }>(
        // Idempotent upsert keyed on the email (legacy unique). We re-assert
        // role + username + password_hash on every run; we never touch
        // production usernames because this script only seeds E2E accounts.
        `INSERT INTO users (email, username, password_hash, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO UPDATE
           SET username = EXCLUDED.username,
               password_hash = EXCLUDED.password_hash,
               role = EXCLUDED.role
         RETURNING id, (xmax = 0) AS inserted`,
        [email, username, hash, defaultUser.role],
      );

      const row = result.rows[0];
      logger.info(
        {
          email,
          username,
          role: defaultUser.role,
          id: row.id,
          inserted: row.inserted,
        },
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