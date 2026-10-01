/**
 * Unit tests for the OtpGrantService — the backoffice-local cache of
 * recently-verified OTPs.
 *
 * The service is exercised through a thin in-memory mock of the pg
 * Pool contract (only `query` is exercised). The tests cover:
 *
 *   - findActive: hit / miss / expiry boundary
 *   - create: inserts with the right expires_at, returns the row
 *   - constructor: rejects non-positive TTLs
 *
 * These tests do NOT need a live DB.
 */
import type pg from 'pg';
import { OtpGrantService } from '../../src/services/otp-grant-service';

interface QueryCall {
  sql: string;
  params: unknown[];
}

interface OtpGrantRow {
  id: number;
  actor: string;
  scope: string;
  otp_id: string;
  created_at: Date;
  expires_at: Date;
}

/**
 * Tiny in-memory "pool" sufficient for the service contract:
 * `query(sql, params) → { rows }`. The `now` column is replaced with
 * a known wall clock so the service's `now() > now` predicates are
 * testable.
 */
function makeClient(opts: {
  /** Rows the next SELECT will return. The mock consumes them FIFO. */
  rows?: OtpGrantRow[];
  /** Wall clock returned by the simulated Postgres `now()`. */
  dbNow?: Date;
  /** Collected INSERT statements. */
  captured?: QueryCall[];
} = {}): {
  client: pg.Pool;
  dbNow: Date;
  rows: OtpGrantRow[];
  captured: QueryCall[];
} {
  const queue: OtpGrantRow[] = [...(opts.rows ?? [])];
  const dbNow = opts.dbNow ?? new Date('2025-01-01T12:00:00Z');
  const captured: QueryCall[] = opts.captured ?? [];
  const client = {
    async query<T extends { rows?: unknown[] }>(
      sql: string,
      params: unknown[] = [],
    ): Promise<T> {
      captured.push({ sql, params });
      if (/INSERT INTO otp_grants/i.test(sql)) {
        const [a, s, otpId, expiresAt] = params as [string, string, string, Date];
        const inserted: OtpGrantRow = {
          id: 100 + captured.length,
          actor: a,
          scope: s,
          otp_id: otpId,
          created_at: dbNow,
          expires_at: expiresAt,
        };
        // The service expects `RETURNING ...` to populate rows[0].
        return { rows: [inserted] } as unknown as T;
      }
      if (/FROM otp_grants/i.test(sql)) {
        const next = queue.shift();
        return { rows: next ? [next] : [] } as unknown as T;
      }
      throw new Error(`unmocked_sql: ${sql}`);
    },
  };
  return { client: client as unknown as pg.Pool, dbNow, rows: queue, captured };
}

describe('OtpGrantService — constructor', () => {
  it('rejects zero or negative TTLs at construction time', () => {
    const { client } = makeClient();
    expect(() => new OtpGrantService(client, { ttlMs: 0 })).toThrow(
      /otp_grant_ttl_must_be_positive/,
    );
    expect(() => new OtpGrantService(client, { ttlMs: -1 })).toThrow(
      /otp_grant_ttl_must_be_positive/,
    );
    expect(() => new OtpGrantService(client, { ttlMs: Number.NaN })).toThrow(
      /otp_grant_ttl_must_be_positive/,
    );
  });

  it('describe() reports the resolved TTL in milliseconds', () => {
    const { client } = makeClient();
    const svc = new OtpGrantService(client, { ttlMs: 20 * 60 * 1000 });
    expect(svc.describe()).toEqual({ ttlMs: 20 * 60 * 1000 });
  });
});

describe('OtpGrantService — findActive', () => {
  it('returns the matching grant when one exists in the future', async () => {
    const now = new Date('2025-01-01T12:00:00Z');
    const expiresAt = new Date('2025-01-01T12:15:00Z');
    const { client } = makeClient({
      rows: [
        {
          id: 7,
          actor: 'admin',
          scope: 'marbete',
          otp_id: 'otp-A',
          created_at: now,
          expires_at: expiresAt,
        },
      ],
    });
    const svc = new OtpGrantService(client, { ttlMs: 20 * 60 * 1000 });
    const grant = await svc.findActive('admin', 'marbete');
    expect(grant).not.toBeNull();
    expect(grant?.id).toBe(7);
    expect(grant?.otp_id).toBe('otp-A');
  });

  it('returns null when no row matches', async () => {
    const { client } = makeClient({ rows: [] });
    const svc = new OtpGrantService(client, { ttlMs: 20 * 60 * 1000 });
    const grant = await svc.findActive('admin', 'marbete');
    expect(grant).toBeNull();
  });

  it('queries with `expires_at > now()` so expired rows are filtered server-side', async () => {
    const { client, captured } = makeClient({ rows: [] });
    const svc = new OtpGrantService(client, { ttlMs: 20 * 60 * 1000 });
    await svc.findActive('admin', 'marbete');
    expect(captured).toHaveLength(1);
    const sql = captured[0]!.sql;
    expect(sql).toMatch(/expires_at\s*>\s*now\(\)/i);
    // The composite index is (actor, scope, expires_at); the query's
    // ORDER BY should pick the most recently created row first.
    expect(sql).toMatch(/ORDER BY\s+created_at\s+DESC/i);
    expect(captured[0]!.params).toEqual(['admin', 'marbete']);
  });
});

describe('OtpGrantService — create', () => {
  it('inserts with expires_at = now() + ttlMs and returns the row', async () => {
    const wallClockMs = Date.UTC(2025, 0, 1, 12, 0, 0);
    const now = () => wallClockMs;
    const { client, captured } = makeClient();
    const svc = new OtpGrantService(client, { ttlMs: 20 * 60 * 1000, now });
    const grant = await svc.create('admin', 'marbete', 'otp-XYZ');
    expect(grant.actor).toBe('admin');
    expect(grant.scope).toBe('marbete');
    expect(grant.otp_id).toBe('otp-XYZ');
    // expires_at = wallClockMs + 20 * 60 * 1000
    expect(grant.expires_at.getTime()).toBe(wallClockMs + 20 * 60 * 1000);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.params).toEqual([
      'admin',
      'marbete',
      'otp-XYZ',
      new Date(wallClockMs + 20 * 60 * 1000),
    ]);
  });

  it('a 20-minute TTL produces a 20-minute window (regression guard)', async () => {
    const wallClockMs = Date.UTC(2025, 0, 1, 12, 0, 0);
    const { client } = makeClient();
    const svc = new OtpGrantService(client, { ttlMs: 20 * 60 * 1000, now: () => wallClockMs });
    const grant = await svc.create('admin', 'marbete', 'otp-XYZ');
    expect(grant.expires_at.getTime() - grant.created_at.getTime()).toBe(20 * 60 * 1000);
  });
});

describe('OtpGrantService — expiry boundary', () => {
  it('a row whose expires_at is exactly now() is NOT considered active (strict `>`)', async () => {
    // `findActive` is server-side (`expires_at > now()`); we model the
    // mock returning no rows because the DB filters it out. The service
    // does not filter client-side, so this test verifies the call
    // shape rather than re-implementing the SQL predicate.
    const { client, captured } = makeClient({ rows: [] });
    const svc = new OtpGrantService(client, { ttlMs: 20 * 60 * 1000 });
    const grant = await svc.findActive('admin', 'marbete');
    expect(grant).toBeNull();
    expect(captured[0]!.sql).toMatch(/expires_at\s*>\s*now\(\)/i);
  });
});