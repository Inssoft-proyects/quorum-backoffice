#!/usr/bin/env tsx
/**
 * Script A — Canvas LMS synthetic students.
 *
 * Idempotently creates N synthetic student accounts in Canvas LMS via
 * the REST API. The synthetic students carry NO personal data; their
 * only identity is the 6-char `[A-Z0-9]` SIS matrícula. Canvas name /
 * login / short_name / sortable_name / sis_user_id are all derived
 * from the matrícula itself so the row can never accidentally leak
 * a real human name or email.
 *
 * Environment variables (env-only, NEVER hardcoded):
 *
 *   SYNTHETIC_STUDENT_COUNT  (default 1000)
 *       Number of synthetic students to create / reuse.
 *
 *   CANVAS_BASE_URL  (default https://lms.quorum.asistentepro.mx)
 *       Base URL of the Canvas LMS instance.
 *
 *   SYNTHETIC_CANVAS_ACCOUNT_ID  (default 2)
 *       Canvas root-account id used for the create-user call
 *       (`POST {CANVAS_BASE_URL}/api/v1/accounts/<id>/users`).
 *       Canvas reserves account id 1 for the system shard; the
 *       production root account for the Quorum tenant is id 2
 *       (verified against the live instance: account id 1 does
 *       not exist for the production token, and
 *       `GET /api/v1/accounts/2` returns `parent_account_id: null`).
 *       Operators can override via this env var for any
 *       non-production target.
 *
 *   CANVAS_ADMIN_TOKEN  (REQUIRED, no default)
 *       Bearer token used to call Canvas's account-users API. Read
 *       from the environment ONLY; the script refuses to run with
 *       a placeholder / empty value.
 *
 *   SYNTHETIC_SEED  (default quorum-synthetic-v1)
 *       Seed for the deterministic matricula generator. Re-runs
 *       with the same seed produce the same matriculas in the
 *       same order; the JSON mapping is then stable end-to-end.
 *
 *   SYNTHETIC_OUTPUT  (default
 *       apps/api/scripts/synthetic/out/students-mapping.json)
 *       Path of the JSON file written at the end of the run. The
 *       backoffice seeder consumes it (env: SYNTHETIC_OUTPUT).
 *
 * Idempotency contract:
 *   - The script first creates each student. On Canvas 400/409
 *     (validation error / conflict — typically "pseudonym.unique_id
 *     taken" or "sis_user_id already linked"), the script performs
 *     a follow-up `GET /api/v1/users/sis_user_id:<MATRICULA>` and
 *     reuses the existing canvas user id.
 *   - The mapping JSON is rewritten on every run with the current
 *     sisId -> canvasUserId projection. Re-running the script
 *     against an already-seeded Canvas is a no-op for users that
 *     already exist (they are looked up and reused).
 *
 * Resilience:
 *   - Bounded concurrency (5 in flight by default; configurable
 *     via SYNTHETIC_CONCURRENCY).
 *   - Per-request timeout (default 15s; SYNTHETIC_TIMEOUT_MS).
 *   - One retry on 5xx / network error before reporting a failure.
 *   - A failed row never aborts the run; a final failures report
 *     is printed and the process exits 0 if every row is either
 *     created or reused.
 *
 * Privacy: synthetic students are pseudonym-only. No name / email /
 * phone / address is sent. Canvas is told `skip_registration=true`
 * and `pseudonym[send_confirmation]=false` so no email channel is
 * created and no Canvas confirmation email is dispatched.
 *
 * Usage (from apps/api):
 *   CANVAS_ADMIN_TOKEN=... npx tsx scripts/synthetic/canvas-students.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  generateMatriculas,
  MFA_FIXTURE_SERIAL,
} from './lib/generate';

// ---------------------------------------------------------------------------
// Config (env-only)
// ---------------------------------------------------------------------------

/**
 * Default Canvas root-account id for the Quorum production tenant.
 * Canvas reserves account id 1 for the internal / system shard; the
 * tenant's actual root account is id 2 (verified against the live
 * instance: account id 1 does not exist for the production token, and
 * `GET /api/v1/accounts/2` returns `parent_account_id: null`).
 */
export const DEFAULT_CANVAS_ACCOUNT_ID = 2;

interface ScriptConfig {
  count: number;
  baseUrl: string;
  adminToken: string;
  seed: string;
  outputPath: string;
  concurrency: number;
  timeoutMs: number;
  accountId: number;
}

function loadConfig(): ScriptConfig {
  const countRaw = process.env['SYNTHETIC_STUDENT_COUNT'] ?? '1000';
  const count = Number.parseInt(countRaw, 10);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(
      `SYNTHETIC_STUDENT_COUNT must be a positive integer (got ${JSON.stringify(countRaw)})`,
    );
  }
  const baseUrl = (process.env['CANVAS_BASE_URL'] ?? 'https://lms.quorum.asistentepro.mx').replace(
    /\/+$/,
    '',
  );
  const adminToken = process.env['CANVAS_ADMIN_TOKEN'] ?? '';
  if (!adminToken || adminToken === 'replace-me' || adminToken.length < 8) {
    throw new Error(
      'CANVAS_ADMIN_TOKEN is required (env-only) and must be at least 8 chars; ' +
        'refusing to run with a placeholder / empty token',
    );
  }
  const seed = process.env['SYNTHETIC_SEED'] ?? 'quorum-synthetic-v1';
  const defaultOutput = resolve(__dirname, 'out', 'students-mapping.json');
  // The user can override via SYNTHETIC_OUTPUT (absolute or relative
  // to the current working directory).
  const outputPath = isAbsolute(process.env['SYNTHETIC_OUTPUT'] ?? '')
    ? (process.env['SYNTHETIC_OUTPUT'] as string)
    : resolve(process.env['SYNTHETIC_OUTPUT'] ?? defaultOutput);
  const concurrency = Number.parseInt(process.env['SYNTHETIC_CONCURRENCY'] ?? '5', 10);
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error('SYNTHETIC_CONCURRENCY must be a positive integer');
  }
  const timeoutMs = Number.parseInt(process.env['SYNTHETIC_TIMEOUT_MS'] ?? '15000', 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('SYNTHETIC_TIMEOUT_MS must be a positive integer');
  }
  const accountIdRaw = process.env['SYNTHETIC_CANVAS_ACCOUNT_ID'] ?? String(DEFAULT_CANVAS_ACCOUNT_ID);
  const accountId = Number.parseInt(accountIdRaw, 10);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw new Error(
      `SYNTHETIC_CANVAS_ACCOUNT_ID must be a positive integer (got ${JSON.stringify(accountIdRaw)})`,
    );
  }
  return { count, baseUrl, adminToken, seed, outputPath, concurrency, timeoutMs, accountId };
}

// ---------------------------------------------------------------------------
// URL builders (pure; exported for unit coverage)
// ---------------------------------------------------------------------------

/**
 * Build the path for `POST {baseUrl}/api/v1/accounts/<id>/users`.
 * Pure function so a future change to the Canvas REST shape
 * (e.g. a new account-id encoding rule) can be unit-tested
 * without standing up a live Canvas instance.
 *
 * The leading `/` is mandatory so the result composes with
 * `cfg.baseUrl` via simple string concatenation, which mirrors
 * the existing `canvasRequest` helper.
 */
export function buildCreateUserPath(accountId: number): string {
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw new Error(`buildCreateUserPath: accountId must be a positive integer (got ${accountId})`);
  }
  return `/api/v1/accounts/${accountId}/users`;
}

// ---------------------------------------------------------------------------
// Canvas user model
// ---------------------------------------------------------------------------

interface CanvasUser {
  id: number;
  name: string;
  short_name?: string;
  sortable_name?: string;
  sis_user_id?: string;
  // The login we sent is a pseudonym unique_id; we don't expect
  // an email channel because we asked for skip_registration=true
  // and didn't supply communication_channel params.
  [k: string]: unknown;
}

interface MappingEntry {
  sisId: string;
  canvasUserId: number;
}

type RowOutcome =
  | { kind: 'created'; sisId: string; canvasUserId: number }
  | { kind: 'reused'; sisId: string; canvasUserId: number }
  | { kind: 'failed'; sisId: string; error: string };

// ---------------------------------------------------------------------------
// HTTP client (form-encoded POST + GET)
// ---------------------------------------------------------------------------

interface RequestOptions {
  method: 'POST' | 'GET';
  path: string;
  formBody?: Record<string, string>;
  timeoutMs: number;
  token: string;
  baseUrl: string;
}

interface CanvasResponse<T> {
  status: number;
  body: T;
}

async function canvasRequest<T>(opts: RequestOptions): Promise<CanvasResponse<T>> {
  const url = `${opts.baseUrl}${opts.path}`;
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${opts.token}`,
  };
  let body: string | undefined;
  if (opts.formBody) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.formBody)) {
      sp.append(k, v);
    }
    body = sp.toString();
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    const r = await fetch(url, {
      method: opts.method,
      headers,
      body,
      signal: ac.signal,
    });
    const text = await r.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    return { status: r.status, body: parsed as T };
  } finally {
    clearTimeout(timer);
  }
}

function asErrorMessage(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as { message?: unknown; errors?: unknown };
    if (typeof b.message === 'string') return b.message;
    if (Array.isArray(b.errors) && b.errors.length > 0) {
      const first = b.errors[0];
      if (first && typeof first === 'object' && 'message' in first) {
        const m = (first as { message?: unknown }).message;
        if (typeof m === 'string') return m;
      }
    }
  }
  return 'unknown_canvas_error';
}

async function createUser(
  matricula: string,
  cfg: ScriptConfig,
): Promise<RowOutcome> {
  // Canvas API convention: `user[name]`, `user[short_name]`,
  // `user[sortable_name]`, `user[sis_user_id]` set the user record;
  // `pseudonym[unique_id]` is the login (we use a synthetic.invalid
  // domain to make it unmistakable in a Canvas admin UI), and
  // `pseudonym[sis_user_id]` mirrors the user-level SIS id so
  // downstream lookups (`GET /api/v1/users/sis_user_id:<id>`) work.
  // `skip_registration=true` + `pseudonym[send_confirmation]=false`
  // ensures NO email channel is created and NO confirmation email
  // is sent. We never send `communication_channel[...]` params so
  // the user truly has no email.
  const formBody: Record<string, string> = {
    'user[name]': matricula,
    'user[short_name]': matricula,
    'user[sortable_name]': matricula,
    'user[sis_user_id]': matricula,
    'pseudonym[unique_id]': `${matricula.toLowerCase()}@synthetic.invalid`,
    'pseudonym[sis_user_id]': matricula,
    'pseudonym[send_confirmation]': 'false',
    skip_registration: 'true',
  };

  let lastErr: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const r = await canvasRequest<CanvasUser>({
        method: 'POST',
        path: buildCreateUserPath(cfg.accountId),
        formBody,
        timeoutMs: cfg.timeoutMs,
        token: cfg.adminToken,
        baseUrl: cfg.baseUrl,
      });
      if (r.status >= 200 && r.status < 300) {
        const user = r.body as CanvasUser;
        if (typeof user.id === 'number') {
          return { kind: 'created', sisId: matricula, canvasUserId: user.id };
        }
        lastErr = 'canvas_response_missing_id';
        continue;
      }
      if (r.status === 400 || r.status === 409 || r.status === 422) {
        // Idempotent: the user probably already exists. Try to
        // look it up by sis_user_id.
        const lookup = await lookupBySisId(matricula, cfg);
        if (lookup) {
          return { kind: 'reused', sisId: matricula, canvasUserId: lookup.id };
        }
        lastErr = `canvas_${r.status}:${asErrorMessage(r.body)}`;
        continue;
      }
      if (r.status >= 500) {
        lastErr = `canvas_${r.status}:${asErrorMessage(r.body)}`;
        // retry once on 5xx
        continue;
      }
      // 4xx other than 400/409/422 are not retried: they signal
      // a malformed request we won't recover from.
      return { kind: 'failed', sisId: matricula, error: `canvas_${r.status}:${asErrorMessage(r.body)}` };
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e.name === 'AbortError') {
        lastErr = 'canvas_timeout';
        continue;
      }
      lastErr = `canvas_network:${e.message ?? 'unknown'}`;
    }
  }
  return { kind: 'failed', sisId: matricula, error: lastErr ?? 'canvas_unknown' };
}

async function lookupBySisId(
  matricula: string,
  cfg: ScriptConfig,
): Promise<{ id: number } | null> {
  try {
    const r = await canvasRequest<CanvasUser>({
      method: 'GET',
      path: `/api/v1/users/sis_user_id:${encodeURIComponent(matricula)}`,
      timeoutMs: cfg.timeoutMs,
      token: cfg.adminToken,
      baseUrl: cfg.baseUrl,
    });
    if (r.status === 200 && r.body && typeof (r.body as CanvasUser).id === 'number') {
      return { id: (r.body as CanvasUser).id };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Concurrency-limited runner
// ---------------------------------------------------------------------------

async function runWithConcurrency<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function pump(): Promise<void> {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      const item = items[idx] as T;
      results[idx] = await worker(item);
    }
  }
  const lanes = Array.from({ length: Math.max(1, concurrency) }, () => pump());
  await Promise.all(lanes);
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig();
  const matriculas = generateMatriculas({ seed: cfg.seed, count: cfg.count });
  // eslint-disable-next-line no-console
  console.log(
    `synthetic_canvas: count=${cfg.count} baseUrl=${cfg.baseUrl} seed=${cfg.seed} ` +
      `concurrency=${cfg.concurrency} timeoutMs=${cfg.timeoutMs}`,
  );

  const t0 = Date.now();
  const outcomes = await runWithConcurrency(matriculas, (m) => createUser(m, cfg), cfg.concurrency);

  let created = 0;
  let reused = 0;
  let failed = 0;
  const mapping: MappingEntry[] = [];
  const failures: { sisId: string; error: string }[] = [];
  for (const o of outcomes) {
    if (o.kind === 'created') {
      created += 1;
      mapping.push({ sisId: o.sisId, canvasUserId: o.canvasUserId });
    } else if (o.kind === 'reused') {
      reused += 1;
      mapping.push({ sisId: o.sisId, canvasUserId: o.canvasUserId });
    } else {
      failed += 1;
      failures.push({ sisId: o.sisId, error: o.error });
    }
  }
  const elapsedMs = Date.now() - t0;

  // Write the mapping JSON. The backoffice seeder reads it.
  await mkdir(dirname(cfg.outputPath), { recursive: true });
  await writeFile(
    cfg.outputPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        seed: cfg.seed,
        count: cfg.count,
        entries: mapping,
      },
      null,
      2,
    ),
    'utf8',
  );

  // eslint-disable-next-line no-console
  console.log(
    `synthetic_canvas_done: created=${created} reused=${reused} failed=${failed} ` +
      `elapsedMs=${elapsedMs} mapping=${cfg.outputPath} ` +
      `mfaFixtureSerial=${MFA_FIXTURE_SERIAL}`,
  );
  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error('synthetic_canvas_failures:');
    for (const f of failures.slice(0, 50)) {
      // eslint-disable-next-line no-console
      console.error(`  ${f.sisId}: ${f.error}`);
    }
    if (failures.length > 50) {
      // eslint-disable-next-line no-console
      console.error(`  ... and ${failures.length - 50} more`);
    }
  }
  // We deliberately do NOT exit non-zero on partial failures: a
  // failed row is logged and counted, but the operator can decide
  // whether to re-run. A non-zero exit would break CI-style chains
  // where the operator wants the mapping JSON regardless.
}

// Only run main() when this file is executed directly. Without
// this guard the script's env validation fires at import time
// (e.g. when the test file imports `buildCreateUserPath`), which
// would crash the Jest harness with a `process.exit(1)` before
// any test runs. tsx + the apps/api CommonJS package compile
// this file to CJS, so `require.main === module` is the right
// entrypoint check.
const isEntrypoint = typeof require !== 'undefined' && require.main === module;

if (isEntrypoint) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('synthetic_canvas_failed', err);
    process.exit(1);
  });
}
