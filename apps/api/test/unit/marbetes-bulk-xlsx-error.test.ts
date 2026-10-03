/**
 * Regression tests for the bulk-xlsx error path.
 *
 * Production logs (2026-10-02) showed that when a pg 23505 escaped
 * bulkCreate (e.g. concurrent writer on marbetes_pkey /
 * marbetes_public_uid_key), Fastify logged TWO entries for one
 * request: the raw pg error followed by
 * `FST_ERR_REP_ALREADY_SENT` ("Reply was already sent, did you
 * forget to return reply in /api/v1/marbetes/bulk-xlsx (POST)?").
 * The client received a generic 500 instead of a mapped conflict.
 *
 * Two contracts are now enforced here:
 *
 *  1. `MarbetesService.bulkCreate` maps pg 23505 from the
 *     transactional INSERT path to a 409 `AppError` (same style as
 *     `MatriculasService.assignBulk` and the single-row `create`
 *     path), so the response is a structured conflict envelope and
 *     the raw pg error never escapes into the "Unknown" branch.
 *
 *  2. The global `httpErrorHandler` sends the reply exactly once.
 *     It must NOT both call `reply.send(envelope)` AND return the
 *     envelope: Fastify's `error-handler.js` calls
 *     `reply.send(result)` on whatever the handler returns, and the
 *     second send logs the `FST_ERR_REP_ALREADY_SENT` warning even
 *     though the response is already on the wire.
 */
import type pg from 'pg';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import { MarbetesService } from '../../src/services/marbetes-service';
import { OtpClient } from '../../src/services/otp-client';
import { AppError, httpErrorHandler } from '../../src/lib/errors';

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

interface PoolQueryHandler {
  match: (sql: string) => boolean;
  run: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
}

/**
 * Minimal pg.Pool stub that lets a test pick the response for
 * specific SQL patterns (most return empty rows) and a single
 * `tx` that forwards to the same `query` shim. This is enough to
 * drive `MarbetesService.bulkCreate` end-to-end without touching a
 * real database.
 */
function makePool(handlers: PoolQueryHandler[]): pg.Pool {
  const client = {
    async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
      for (const h of handlers) {
        if (h.match(sql)) return h.run(sql, params) as Promise<{ rows: T[] }>;
      }
      // BEGIN / COMMIT / ROLLBACK and other housekeeping queries
      // succeed silently.
      return { rows: [] };
    },
    async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
      // The real `tx` BEGIN/COMMIT/ROLLBACK lifecycle is exercised
      // by the parent pool's `query` shim (the BEGIN/COMMIT/ROLLBACK
      // regex below catches them and returns empty rows). The
      // rollback-then-rethrow semantics are preserved: if `fn`
      // throws, the surrounding `tx` would roll back — the test only
      // cares that the original error is rethrown unchanged.
      return fn(client as unknown as pg.PoolClient);
    },
  };
  return client as unknown as pg.Pool;
}

function throwingHandler(
  sqlPattern: RegExp,
  error: unknown,
): PoolQueryHandler {
  return {
    match: (sql) => sqlPattern.test(sql),
    run: async () => {
      throw error;
    },
  };
}

function emptyRowsHandler(sqlPattern: RegExp): PoolQueryHandler {
  return {
    match: (sql) => sqlPattern.test(sql),
    run: async () => ({ rows: [] }),
  };
}

/** OtpClient that accepts the literal OTP "111111" and rejects others. */
function makeOtpClient(): OtpClient {
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    const parsed = JSON.parse(raw) as { token?: string };
    if (parsed.token === '111111') {
      return new Response(JSON.stringify({ valid: true, otp_id: 'OTP-FRESH' }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ error: 'verify_rejected' }), { status: 409 });
  }) as unknown as typeof fetch;
  return new OtpClient({
    baseUrl: 'http://127.0.0.1:65535',
    serviceToken: 'test-token-1234567890',
    fetchImpl,
  });
}

// ---------------------------------------------------------------------------
// Service-level: pg 23505 must surface as a mapped AppError.
// ---------------------------------------------------------------------------

describe('MarbetesService.bulkCreate — pg 23505 mapping', () => {
  it('maps marbetes_pkey 23505 from bulkInsert to a 409 AppError', async () => {
    const pool = makePool([
      // Pre-flight duplicate check: nobody exists yet.
      emptyRowsHandler(/FROM marbetes\s+WHERE code_hash = ANY/i),
      // The race: concurrent writer snuck in with the same id/pk.
      throwingHandler(
        /INSERT INTO marbetes/i,
        Object.assign(new Error('duplicate key value violates unique constraint "marbetes_pkey"'), {
          code: '23505',
          constraint: 'marbetes_pkey',
        }),
      ),
    ]);
    const svc = new MarbetesService({ pool, log: silentLogger, otp: makeOtpClient() });

    await expect(
      svc.bulkCreate(
        'admin',
        { items: [{ code: '12345678' }, { code: '87654321' }] },
        'xlsx',
        'lote.xlsx',
        '111111',
        {},
      ),
    ).rejects.toBeInstanceOf(AppError);

    await expect(
      svc.bulkCreate(
        'admin',
        { items: [{ code: '12345678' }, { code: '87654321' }] },
        'xlsx',
        'lote.xlsx',
        '111111',
        {},
      ),
    ).rejects.toMatchObject({
      code: 'marbete_bulk_conflict',
      httpStatus: 409,
      details: { constraint: 'marbetes_pkey' },
    });
  });

  it('maps marbetes_public_uid_key 23505 to the same conflict AppError', async () => {
    const pool = makePool([
      emptyRowsHandler(/FROM marbetes\s+WHERE code_hash = ANY/i),
      throwingHandler(
        /INSERT INTO marbetes/i,
        Object.assign(new Error('duplicate key value violates unique constraint "marbetes_public_uid_key"'), {
          code: '23505',
          constraint: 'marbetes_public_uid_key',
        }),
      ),
    ]);
    const svc = new MarbetesService({ pool, log: silentLogger, otp: makeOtpClient() });

    await expect(
      svc.bulkCreate(
        'admin',
        { items: [{ code: '12345678' }] },
        'xlsx',
        'lote.xlsx',
        '111111',
        {},
      ),
    ).rejects.toMatchObject({
      code: 'marbete_bulk_conflict',
      httpStatus: 409,
      details: { constraint: 'marbetes_public_uid_key' },
    });
  });

  it('rethrows non-23505 errors (e.g. connection reset) as-is, not as AppError', async () => {
    const pool = makePool([
      emptyRowsHandler(/FROM marbetes\s+WHERE code_hash = ANY/i),
      throwingHandler(
        /INSERT INTO marbetes/i,
        Object.assign(new Error('connection terminated'), { code: '08006' }),
      ),
    ]);
    const svc = new MarbetesService({ pool, log: silentLogger, otp: makeOtpClient() });

    // We don't want a connection error to be silently re-labeled as
    // a 409 conflict — the operator should see a 5xx so the request
    // is retried at the gateway level, not the application level.
    await expect(
      svc.bulkCreate(
        'admin',
        { items: [{ code: '12345678' }] },
        'xlsx',
        'lote.xlsx',
        '111111',
        {},
      ),
    ).rejects.not.toBeInstanceOf(AppError);
    await expect(
      svc.bulkCreate(
        'admin',
        { items: [{ code: '12345678' }] },
        'xlsx',
        'lote.xlsx',
        '111111',
        {},
      ),
    ).rejects.toMatchObject({ code: '08006' });
  });

  it('rethrows AppError.internal raised inside the tx body (e.g. bulk_insert_returned_incomplete) as-is', async () => {
    // Insert succeeds but returns a different set of uids than we
    // sent, which trips the `AppError.internal('bulk_insert_returned_incomplete')`
    // guard. The fix must NOT swallow legitimate AppErrors thrown
    // by the service itself.
    const pool = makePool([
      emptyRowsHandler(/FROM marbetes\s+WHERE code_hash = ANY/i),
      {
        match: (sql) => /INSERT INTO marbetes/i.test(sql),
        run: async () => ({
          rows: [
            {
              id: 99,
              public_uid: 'm-WRONG-UID',
              status: 'active',
              assigned_student_id: null,
              assigned_at: null,
              created_at: new Date('2025-01-01T00:00:00Z'),
              created_by: 'admin',
              deleted_at: null,
              deletion_reason: null,
            },
          ],
        }),
      },
    ]);
    const svc = new MarbetesService({ pool, log: silentLogger, otp: makeOtpClient() });

    await expect(
      svc.bulkCreate(
        'admin',
        { items: [{ code: '12345678' }] },
        'xlsx',
        'lote.xlsx',
        '111111',
        {},
      ),
    ).rejects.toMatchObject({ code: 'internal', httpStatus: 500 });
  });
});

// ---------------------------------------------------------------------------
// httpErrorHandler: single-send contract.
// ---------------------------------------------------------------------------

interface MockReply {
  reply: FastifyReply;
  send: jest.Mock;
  status: jest.Mock;
}

function makeMockReply(): MockReply {
  // The real Fastify chain is `reply.status(code).send(payload)`.
  // We mirror that: `status` returns a chainable `{ send }`, and
  // `send` records the call AND returns `this` (so chained methods
  // remain chainable in any accidental re-use).
  const send = jest.fn(function send(this: unknown, _payload: unknown) {
    return this;
  });
  const status = jest.fn(function status(this: unknown, _code: number) {
    return { send };
  });
  const reply = { status, send } as unknown as FastifyReply;
  return { reply, send, status };
}

function makeMockReq(): FastifyRequest {
  return {
    id: 'trace-123',
    log: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
  } as unknown as FastifyRequest;
}

describe('httpErrorHandler — single-send contract', () => {
  it('returns void (NOT the envelope) so Fastify does not call reply.send a second time', () => {
    const { reply } = makeMockReply();
    const req = makeMockReq();
    const result = httpErrorHandler(new Error('boom'), req, reply);
    // The contract: returning the envelope causes Fastify's
    // error-handler.js to call reply.send(result) on top of the
    // explicit reply.send(envelope) the handler already performed,
    // which logs FST_ERR_REP_ALREADY_SENT. A void return breaks the
    // chain.
    expect(result).toBeUndefined();
  });

  it('calls reply.send exactly once for a raw Error', () => {
    const { reply, send, status } = makeMockReply();
    const req = makeMockReq();
    httpErrorHandler(new Error('boom'), req, reply);
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(500);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'internal', message: 'internal server error', traceId: 'trace-123' }),
    );
  });

  it('calls reply.send exactly once for an AppError', () => {
    const { reply, send, status } = makeMockReply();
    const req = makeMockReq();
    const err = new AppError('code_already_exists', 'duplicate', 409, { foo: 1 });
    httpErrorHandler(err, req, reply);
    expect(status).toHaveBeenCalledWith(409);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'code_already_exists', message: 'duplicate', traceId: 'trace-123', details: { foo: 1 } }),
    );
  });

  it('calls reply.send exactly once for a ZodError', () => {
    const { reply, send, status } = makeMockReply();
    const req = makeMockReq();
    const zodErr = new ZodError([{ path: ['x'], message: 'bad', code: 'custom' }]);
    // Force the duck-typed issues check to pass by using a schema
    // that actually fails parsing.
    const failing = z
      .object({ x: z.string() })
      .safeParse({ x: 1 } as unknown).error!;
    // Use `failing` (a real ZodError from a real parse).
    void zodErr;
    httpErrorHandler(failing, req, reply);
    expect(status).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'validation_error',
        message: 'request payload failed validation',
        traceId: 'trace-123',
        details: expect.any(Array),
      }),
    );
  });

  it('calls reply.send exactly once for a Fastify validation error (has `.validation`)', () => {
    const { reply, send, status } = makeMockReply();
    const req = makeMockReq();
    // Fastify validation errors carry `.validation` (the Zod issues)
    // and `.statusCode`. We construct a minimal stand-in matching
    // the duck-typed branch in httpErrorHandler.
    const fastifyErr = Object.assign(new Error('FST_ERR_VALIDATION'), {
      validation: [{ instancePath: '/x', message: 'bad' }],
      statusCode: 400,
    });
    httpErrorHandler(fastifyErr, req, reply);
    expect(status).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
