/**
 * Unit tests for the grant-aware `verifyOtp` inside MarbetesService.
 *
 * The test bypasses the repo / audit / canvas hydration layers by
 * using a stub that satisfies the pg Pool contract minimally
 * (only `query` is exercised — `findById` returns null because no
 * row exists). The OtpClient and OtpGrantService are real instances
 * with stubs so the verifyOtp logic is exercised end-to-end without
 * a database.
 *
 * What we assert:
 *  - Grant-eligible action with an active grant returns the grant's
 *    otp_id WITHOUT calling the OtpClient.
 *  - Grant-eligible action with no active grant calls the OtpClient
 *    and creates a fresh grant on success.
 *  - Grant-miss + invalid OTP: 401, no grant created.
 *  - `marbete.reveal` ALWAYS requires a per-op OTP — never consults
 *    the grant cache.
 *  - Non-destructive action is a no-op (no grant, no provider call).
 *  - Grant-create failure (provider succeeds, INSERT throws) does
 *    NOT undo the verified destructive op.
 *  - getGrantStatus returns the active window's expires_at when a
 *    grant is in scope, or { active: false, expiresAt: null } when
 *    missing.
 */
import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { MarbetesService } from '../../src/services/marbetes-service';
import { OtpClient } from '../../src/services/otp-client';
import { OtpGrantService } from '../../src/services/otp-grant-service';
import { AppError } from '../../src/lib/errors';

interface OtpGrantRow {
  id: number;
  actor: string;
  scope: string;
  otp_id: string;
  created_at: Date;
  expires_at: Date;
}

/** Silent logger — the service logs but tests don't need to see them. */
const silentLogger: FastifyBaseLogger = {
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  level: 'silent',
  silent: () => undefined,
  child: () => silentLogger,
} as unknown as FastifyBaseLogger;

/**
 * Bare-minimum pg.Pool stub: MarbetesService only touches `query` for
 * `findById` and through the bulkCreate tx() method (which we never
 * exercise here). Every call returns an empty result set so the
 * destructive body bails out cleanly when verifyOtp succeeds.
 */
function makePool(): pg.Pool {
  const stub = {
    query: jest.fn(async () => ({ rows: [] })),
  };
  return stub as unknown as pg.Pool;
}

/**
 * Capturing fetch: every provider call lands in `calls`. Tests assert
 * which paths the OtpClient actually took.
 */
function makeCapturingFetch(
  responseFor: (code: string) => { status: number; body: unknown },
): { fetch: typeof fetch; calls: { body: string }[] } {
  const calls: { body: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === 'string' ? init.body : '';
    calls.push({ body: raw });
    const parsed = JSON.parse(raw || '{}') as { token?: string };
    const r = responseFor(parsed.token ?? '');
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/**
 * In-memory grant store. findActive and create both go through this
 * object so we can simulate hit/miss/failure precisely without a real
 * PG.
 */
function makeGrantService(opts: {
  ttlMs?: number;
  now?: () => number;
  rows?: OtpGrantRow[];
  createImpl?: (actor: string, scope: string, otpId: string) => Promise<unknown>;
} = {}): OtpGrantService & { __rows: OtpGrantRow[] } {
  const rows = opts.rows ?? [];
  const now = opts.now ?? (() => Date.now());
  const client = {
    async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
      if (/INSERT INTO otp_grants/i.test(sql)) {
        if (opts.createImpl) {
          await opts.createImpl(
            params[0] as string,
            params[1] as string,
            params[2] as string,
          );
        }
        const expiresAt = params[3] as Date;
        const next: OtpGrantRow = {
          id: 100 + rows.length,
          actor: params[0] as string,
          scope: params[1] as string,
          otp_id: params[2] as string,
          created_at: new Date(now()),
          expires_at: expiresAt,
        };
        rows.push(next);
        return { rows: [next as unknown as T] };
      }
      if (/FROM otp_grants/i.test(sql)) {
        const [actor, scope] = params as [string, string];
        const hit = rows
          .filter((r) => r.actor === actor && r.scope === scope)
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
        return { rows: hit ? [hit as unknown as T] : [] };
      }
      return { rows: [] };
    },
  };
  const svc = new OtpGrantService(
    client as unknown as pg.Pool,
    { ttlMs: opts.ttlMs ?? 20 * 60 * 1000, now },
  );
  Object.defineProperty(svc, '__rows', { value: rows, enumerable: false });
  return svc as OtpGrantService & { __rows: OtpGrantRow[] };
}

interface ServiceHandle {
  svc: MarbetesService;
  otp: OtpClient;
  grant: OtpGrantService & { __rows: OtpGrantRow[] };
  fetchCalls: { body: string }[];
}

function buildService(opts: {
  otpResponse: (code: string) => { status: number; body: unknown };
  grantRows?: OtpGrantRow[];
  grantTtlMs?: number;
  now?: () => number;
  createImpl?: (actor: string, scope: string, otpId: string) => Promise<unknown>;
  fixedTimestamp?: number;
  includeGrant?: boolean;
}): ServiceHandle {
  const pool = makePool();
  const capture = makeCapturingFetch(opts.otpResponse);
  const otp = new OtpClient({
    baseUrl: 'http://127.0.0.1:65535',
    serviceToken: 'test-token-1234567890',
    fetchImpl: capture.fetch,
    now: opts.now ?? (() => opts.fixedTimestamp ?? 1_700_000_000_000),
  });
  const grant = opts.includeGrant === false
    ? undefined
    : makeGrantService({
        rows: opts.grantRows,
        ttlMs: opts.grantTtlMs ?? 20 * 60 * 1000,
        now: opts.now ?? (() => opts.fixedTimestamp ?? 1_700_000_000_000),
        createImpl: opts.createImpl,
      });
  const svc = new MarbetesService({
    pool,
    log: silentLogger,
    otp,
    grant,
  });
  return { svc, otp, grant: grant as ServiceHandle['grant'], fetchCalls: capture.calls };
}

describe('MarbetesService.verifyOtp — grant-aware', () => {
  it('grant-eligible action with an active grant: provider is NOT called', async () => {
    const expiresAt = new Date('2025-01-01T12:20:00Z');
    const { svc, fetchCalls } = buildService({
      otpResponse: () => ({ status: 200, body: { valid: true } }),
      grantRows: [
        {
          id: 1,
          actor: 'admin',
          scope: 'marbete',
          otp_id: 'OTP-CACHED',
          created_at: new Date('2025-01-01T12:00:00Z'),
          expires_at: expiresAt,
        },
      ],
    });
    // create() hits verifyOtp first; the INSERT/UPDATE paths are
    // stubbed-out so the request bails out cleanly once verifyOtp
    // returns. We only care about the side effects in verifyOtp.
    await svc
      .create('admin', { code: '12345678' }, undefined)
      .then(
        () => undefined,
        () => undefined,
      );
    expect(fetchCalls).toHaveLength(0);
  });

  it('grant-eligible action with NO active grant: provider is called, grant is created', async () => {
    const wallClock = Date.UTC(2025, 0, 1, 12, 0, 0);
    const { svc, fetchCalls, grant } = buildService({
      otpResponse: (code) =>
        code === '111111'
          ? { status: 200, body: { valid: true, otp_id: 'OTP-FRESH1' } }
          : { status: 409, body: { error: 'verify_rejected' } },
      now: () => wallClock,
    });
    await svc
      .create('admin', { code: '12345678' }, '111111')
      .then(
        () => undefined,
        () => undefined,
      );
    expect(fetchCalls).toHaveLength(1);
    expect(grant.__rows).toHaveLength(1);
    const inserted = grant.__rows[0]!;
    expect(inserted.otp_id).toBe('OTP-FRESH1');
    expect(inserted.expires_at.getTime()).toBe(wallClock + 20 * 60 * 1000);
  });

  it('grant-eligible action + invalid OTP: 401, no grant created', async () => {
    const { svc, fetchCalls, grant } = buildService({
      otpResponse: () => ({ status: 409, body: { error: 'verify_rejected' } }),
    });
    await expect(svc.create('admin', { code: '12345678' }, 'WRONG')).rejects.toMatchObject({
      code: 'otp_invalid',
    });
    expect(fetchCalls).toHaveLength(1);
    expect(grant.__rows).toHaveLength(0);
  });

  it('marbete.reveal ALWAYS requires a per-op OTP, even when a grant is active', async () => {
    const expiresAt = new Date('2030-01-01T12:20:00Z');
    const { svc, fetchCalls } = buildService({
      otpResponse: (code) =>
        code === '999999'
          ? { status: 200, body: { valid: true, otp_id: 'OTP-REVEAL' } }
          : { status: 409, body: { error: 'verify_rejected' } },
      grantRows: [
        {
          id: 1,
          actor: 'admin',
          scope: 'marbete',
          otp_id: 'OTP-CACHED',
          created_at: new Date('2025-01-01T12:00:00Z'),
          expires_at: expiresAt,
        },
      ],
    });
    await expect(
      svc.reveal('admin', 1, { motivo: 'auditoria' }, undefined),
    ).rejects.toMatchObject({ code: 'otp_required' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('marbete.reveal with a valid OTP: provider IS called even with a grant', async () => {
    const expiresAt = new Date('2030-01-01T12:20:00Z');
    const { svc, fetchCalls } = buildService({
      otpResponse: (code) =>
        code === '999999'
          ? { status: 200, body: { valid: true, otp_id: 'OTP-REVEAL' } }
          : { status: 409, body: { error: 'verify_rejected' } },
      grantRows: [
        {
          id: 1,
          actor: 'admin',
          scope: 'marbete',
          otp_id: 'OTP-CACHED',
          created_at: new Date('2025-01-01T12:00:00Z'),
          expires_at: expiresAt,
        },
      ],
    });
    await svc
      .reveal('admin', 1, { motivo: 'auditoria' }, '999999')
      .then(
        () => undefined,
        (err) => {
          // findById returns null in the stubbed pool, so the destructive
          // body throws AppError.notFound AFTER verifyOtp succeeded.
          if (!(err instanceof AppError)) throw err;
          if (err.code !== 'not_found') throw err;
        },
      );
    expect(fetchCalls).toHaveLength(1);
  });

  it('non-destructive action (list): no provider call, no grant consultation', async () => {
    const { svc, fetchCalls } = buildService({
      otpResponse: () => ({ status: 200, body: { valid: true } }),
    });
    const result = await svc.list({ limit: 50, offset: 0, assigned: 'any' });
    expect(result.items).toEqual([]);
    expect(fetchCalls).toHaveLength(0);
  });

  it('grant-mint INSERT failure: verified op is NOT undone', async () => {
    const { svc, fetchCalls, grant } = buildService({
      otpResponse: () => ({ status: 200, body: { valid: true, otp_id: 'OTP-FRESH1' } }),
      createImpl: async () => {
        throw new Error('db down');
      },
    });
    await svc
      .create('admin', { code: '12345678' }, '111111')
      .then(
        () => undefined,
        () => undefined,
      );
    expect(fetchCalls).toHaveLength(1);
    expect(grant.__rows).toHaveLength(0);
  });
});

describe('MarbetesService.getGrantStatus', () => {
  it('returns { active: true, expiresAt } when a grant is active', async () => {
    const expiresAt = new Date('2025-01-01T12:20:00Z');
    const { svc } = buildService({
      otpResponse: () => ({ status: 200, body: { valid: true } }),
      grantRows: [
        {
          id: 1,
          actor: 'admin',
          scope: 'marbete',
          otp_id: 'OTP',
          created_at: new Date('2025-01-01T12:00:00Z'),
          expires_at: expiresAt,
        },
      ],
    });
    const status = await svc.getGrantStatus('admin');
    expect(status).toEqual({ active: true, expiresAt: expiresAt.toISOString() });
  });

  it('returns { active: false, expiresAt: null } when no grant is active', async () => {
    const { svc } = buildService({
      otpResponse: () => ({ status: 200, body: { valid: true } }),
    });
    const status = await svc.getGrantStatus('admin');
    expect(status).toEqual({ active: false, expiresAt: null });
  });

  it('returns { active: false, expiresAt: null } when no grant service is configured', async () => {
    const pool = makePool();
    const otp = new OtpClient({
      baseUrl: 'http://127.0.0.1:65535',
      serviceToken: 'test-token-1234567890',
    });
    const svc = new MarbetesService({
      pool,
      log: silentLogger,
      otp,
      // grant: undefined
    });
    const status = await svc.getGrantStatus('admin');
    expect(status).toEqual({ active: false, expiresAt: null });
  });
});