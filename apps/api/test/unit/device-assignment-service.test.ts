/**
 * B2b / Admin device-to-student assignment — service layer unit tests.
 *
 * Pure mocked-environment contract for DispositivosService.assign and
 * DispositivosService.unassign. The pool, OtpClient, and audit path are
 * all stubbed; the test asserts ONLY what the service is responsible
 * for:
 *
 *   - verifyOtp is called with the correct scope ('dispositivo.assign'
 *     or 'dispositivo.unassign')
 *   - missing OTP -> 401 otp_required (NO write, NO audit)
 *   - rejected OTP -> 401 otp_invalid (NO write, NO audit)
 *   - 404 when the device does not exist
 *   - 409 when assigning to a revoked device
 *   - 422 student_not_found / student_not_active (NO write, NO audit)
 *   - happy path writes audit with before/after snapshots AND
 *     otpId sourced from verifyOtp
 *   - reassignment overwrites assigned_student_id and the audit
 *     before/after diff captures both states
 *   - unassign clears assigned_student_id and writes audit
 *   - unassign on a row that is already unassigned -> 409
 *     device_not_assigned (no write, no audit)
 *
 * The matching integration suite (test/integration/device-assignment-
 * service.test.ts) exercises the same contract end-to-end against a
 * real PostgreSQL. This unit file stays deterministic and never
 * touches a database.
 */
import type pg from 'pg';
import { AppError } from '../../src/lib/errors';
import { DispositivosService } from '../../src/services/dispositivos-service';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Captures every SQL statement the service (and its repository) issues so
 * the tests can assert on writes and audit rows. Return values are
 * programmed per-call by the test (see `setQueryResult`).
 */
interface QueryCall {
  sql: string;
  params: unknown[];
}

interface PoolFakeOptions {
  /**
   * Programmable query responses, keyed by the trimmed SQL template the
   * service will issue. The first matching key wins (insertion order).
   * Special wildcard `'*'` matches any unprogrammed query and returns the
   * provided default.
   */
  responses?: Array<{ match: string; rows: Record<string, unknown>[] }>;
  defaultRows?: Record<string, unknown>[];
  defaultRowCount?: number;
}

function makePoolFake(opts: PoolFakeOptions = {}): {
  pool: pg.Pool;
  calls: QueryCall[];
  setNextResult: (match: string, rows: Record<string, unknown>[]) => void;
  setDefault: (rows: Record<string, unknown>[]) => void;
} {
  const calls: QueryCall[] = [];
  const responses: Array<{ match: string; rows: Record<string, unknown>[] }> = [
    ...(opts.responses ?? []),
  ];
  let defaultRows: Record<string, unknown>[] = opts.defaultRows ?? [];

  const client = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const normalized = sql.replace(/\s+/g, ' ').trim();
      // Try the first matching programmed response in insertion order.
      for (const r of responses) {
        if (normalized.includes(r.match)) return { rows: r.rows };
      }
      // No programmatic response: return the default. Tests must opt-in
      // for non-default behaviour, so any unexpected call is loud.
      return { rows: defaultRows };
    }),
  } as unknown as pg.Pool;

  return {
    pool: client as pg.Pool,
    calls,
    setNextResult: (match: string, rows: Record<string, unknown>[]) => {
      // Override (or append) so the most recent declaration wins.
      const idx = responses.findIndex((r) => r.match === match);
      if (idx >= 0) responses[idx] = { match, rows };
      else responses.push({ match, rows });
    },
    setDefault: (rows: Record<string, unknown>[]) => {
      defaultRows = rows;
    },
  };
}

function makeOtpFake(
  result:
    | { kind: 'ok'; otpId: string }
    | { kind: 'rejected'; reason: string },
): { otp: { verify: jest.Mock }; verifyCalls: Array<{ subject: string; scope: string; code: string }> } {
  const verifyCalls: Array<{ subject: string; scope: string; code: string }> = [];
  const verify = jest.fn(async (args: { subject: string; scope: string; code: string }) => {
    verifyCalls.push({ subject: args.subject, scope: args.scope, code: args.code });
    if (result.kind === 'ok') return { ok: true as const, otpId: result.otpId };
    return { ok: false as const, reason: result.reason };
  });
  return { otp: { verify }, verifyCalls };
}

const FAKE_LOGGER = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  child: () => FAKE_LOGGER,
  level: 'silent',
  silent: () => undefined,
} as unknown as import('fastify').FastifyBaseLogger;

// ---------------------------------------------------------------------------
// Row / response helpers
// ---------------------------------------------------------------------------

function activeRow(
  id: number,
  serial: string,
  assignedStudentId: number | null = null,
): Record<string, unknown> {
  return {
    id,
    serial_number: serial,
    brand: 'Apple',
    model: 'iPad Pro',
    status: 'active',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    created_by: 'seed',
    revoked_at: null,
    revoked_reason: null,
    assigned_student_id: assignedStudentId,
  };
}

function revokedRow(
  id: number,
  serial: string,
  assignedStudentId: number | null = null,
): Record<string, unknown> {
  return {
    ...activeRow(id, serial, assignedStudentId),
    status: 'revoked',
    revoked_at: new Date('2026-02-01T00:00:00.000Z'),
    revoked_reason: 'stolen',
  };
}

function studentRow(canvasUserId: number, isActive: boolean, id: number): Record<string, unknown> {
  return {
    id,
    canvas_user_id: canvasUserId,
    full_name: 'Marie Curie',
    email: 'marie@quorum.local',
    last_synced_at: new Date('2026-01-01T00:00:00.000Z'),
    is_active: isActive,
  };
}

const ACTOR = 'admin@quorum.local';
const DEVICE_ID = 1;
const DEVICE_SERIAL = 'SN-UNIT-ASSIGN-1';
const STUDENT_INTERNAL_ID = 4242;
const CANVAS_USER_ID = 9001;
const ASSIGNED_STUDENT_ID = 7000; // pre-existing owner for reassignment test
const META = { ip: '127.0.0.1', userAgent: 'jest-unit/1.0' };

function findAuditWriteCall(calls: QueryCall[]): QueryCall | undefined {
  return calls.find((c) => c.sql.toLowerCase().includes('insert into audit_log'));
}

function findSql(calls: QueryCall[], contains: string): QueryCall | undefined {
  return calls.find((c) => c.sql.toLowerCase().includes(contains.toLowerCase()));
}

// ---------------------------------------------------------------------------
// assign() — happy path
// ---------------------------------------------------------------------------

describe('DispositivosService.assign (unit, mocked pool/otp/audit)', () => {
  it('happy path: writes audit with before/after snapshots and the otpId from verifyOtp', async () => {
    // The service issues the read (findById), then a write (assignStudent),
    // then an audit_log INSERT. We only need the first SELECT to return the
    // existing device (no owner), and the UPDATE to return the post-write
    // row (owner set). Everything else is "no rows".
    const { pool, calls } = makePoolFake({
      responses: [
        { match: 'FROM dispositivos', rows: [activeRow(DEVICE_ID, DEVICE_SERIAL, null)] },
        { match: 'students_cache', rows: [studentRow(CANVAS_USER_ID, true, STUDENT_INTERNAL_ID)] },
        {
          match: 'UPDATE dispositivos',
          rows: [activeRow(DEVICE_ID, DEVICE_SERIAL, STUDENT_INTERNAL_ID)],
        },
      ],
    });
    const { otp, verifyCalls } = makeOtpFake({ kind: 'ok', otpId: 'otp-unit-1' });

    const svc = new DispositivosService({ pool, log: FAKE_LOGGER, otp: otp as never });
    const result = await svc.assign(ACTOR, DEVICE_ID, { canvasUserId: CANVAS_USER_ID }, '123456', META);

    // 1) OTP was called with the exact new scope.
    expect(verifyCalls).toEqual([
      { subject: ACTOR, scope: 'dispositivo.assign', code: '123456' },
    ]);

    // 2) Exactly one UPDATE on dispositivos (the assignment write).
    const updateCalls = calls.filter((c) => c.sql.toLowerCase().includes('update dispositivos'));
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.params).toEqual([DEVICE_ID, STUDENT_INTERNAL_ID]);

    // 3) Exactly one audit_log INSERT, with the otpId from verifyOtp.
    const auditCall = findAuditWriteCall(calls);
    expect(auditCall).toBeDefined();
    const auditParams = auditCall?.params ?? [];
    // INSERT order: actor, actorEmail, action, entityType, entityId,
    // beforeJson (string), afterJson (string), otpId, ip (inet), userAgent.
    expect(auditParams[2]).toBe('dispositivo.assign');
    expect(auditParams[3]).toBe('dispositivo');
    expect(auditParams[4]).toBe(String(DEVICE_ID));
    expect(auditParams[7]).toBe('otp-unit-1');
    expect(auditParams[8]).toBe(META.ip);
    expect(auditParams[9]).toBe(META.userAgent);

    // 4) before/after JSON snapshots reflect unassigned -> assigned.
    const beforeJson = JSON.parse(String(auditParams[5])) as { assignedStudentId: number | null };
    const afterJson = JSON.parse(String(auditParams[6])) as { assignedStudentId: number | null };
    expect(beforeJson.assignedStudentId).toBeNull();
    expect(afterJson.assignedStudentId).toBe(STUDENT_INTERNAL_ID);

    // 5) Returned response mirrors the after-snapshot.
    expect(result.assignedStudentId).toBe(STUDENT_INTERNAL_ID);
  });

  it('reassignment: a different existing owner is replaced; before/after diff captures both', async () => {
    // Pre-existing owner is the same internal student id we are about to
    // rebind to a NEW canvas user — this exercises the "different owner"
    // branch and ensures the BEFORE snapshot carries the previous id.
    const NEW_CANVAS_USER_ID = 9002;
    const NEW_INTERNAL_ID = 4243;

    const { pool, calls } = makePoolFake({
      responses: [
        {
          match: 'FROM dispositivos',
          rows: [activeRow(DEVICE_ID, DEVICE_SERIAL, ASSIGNED_STUDENT_ID)],
        },
        { match: 'students_cache', rows: [studentRow(NEW_CANVAS_USER_ID, true, NEW_INTERNAL_ID)] },
        {
          match: 'UPDATE dispositivos',
          rows: [activeRow(DEVICE_ID, DEVICE_SERIAL, NEW_INTERNAL_ID)],
        },
      ],
    });
    const { otp } = makeOtpFake({ kind: 'ok', otpId: 'otp-unit-reassign' });

    const svc = new DispositivosService({ pool, log: FAKE_LOGGER, otp: otp as never });
    await svc.assign(ACTOR, DEVICE_ID, { canvasUserId: NEW_CANVAS_USER_ID }, '123456', META);

    const auditCall = findAuditWriteCall(calls);
    expect(auditCall).toBeDefined();
    const before = JSON.parse(String(auditCall?.params[5])) as { assignedStudentId: number | null };
    const after = JSON.parse(String(auditCall?.params[6])) as { assignedStudentId: number | null };
    expect(before.assignedStudentId).toBe(ASSIGNED_STUDENT_ID);
    expect(after.assignedStudentId).toBe(NEW_INTERNAL_ID);

    // The actual UPDATE bind params still go to the new internal id.
    const updateCall = calls.find((c) => c.sql.toLowerCase().includes('update dispositivos'));
    expect(updateCall?.params).toEqual([DEVICE_ID, NEW_INTERNAL_ID]);
  });
});

// ---------------------------------------------------------------------------
// assign() — fail-closed branches
// ---------------------------------------------------------------------------

describe('DispositivosService.assign — fail-closed error branches (unit)', () => {
  it('missing OTP -> 401 otp_required; no repo write; no audit row', async () => {
    const { pool, calls } = makePoolFake({
      responses: [
        { match: 'FROM dispositivos', rows: [activeRow(DEVICE_ID, DEVICE_SERIAL, null)] },
      ],
    });
    const { otp, verifyCalls } = makeOtpFake({ kind: 'ok', otpId: 'unreachable' });

    const svc = new DispositivosService({ pool, log: FAKE_LOGGER, otp: otp as never });
    await expect(
      svc.assign(ACTOR, DEVICE_ID, { canvasUserId: CANVAS_USER_ID }, undefined, META),
    ).rejects.toMatchObject({ code: 'otp_required', httpStatus: 401 });

    expect(verifyCalls).toEqual([]); // verifyOtp short-circuited before calling
    expect(calls.some((c) => c.sql.toLowerCase().includes('update dispositivos'))).toBe(false);
    expect(findAuditWriteCall(calls)).toBeUndefined();
  });

  it('rejected OTP -> 401 otp_invalid; no repo write; no audit row', async () => {
    const { pool, calls } = makePoolFake({
      responses: [
        { match: 'FROM dispositivos', rows: [activeRow(DEVICE_ID, DEVICE_SERIAL, null)] },
      ],
    });
    const { otp, verifyCalls } = makeOtpFake({ kind: 'rejected', reason: 'invalid' });

    const svc = new DispositivosService({ pool, log: FAKE_LOGGER, otp: otp as never });
    await expect(
      svc.assign(ACTOR, DEVICE_ID, { canvasUserId: CANVAS_USER_ID }, 'wrong-code', META),
    ).rejects.toMatchObject({ code: 'otp_invalid', httpStatus: 401 });

    expect(verifyCalls).toEqual([
      { subject: ACTOR, scope: 'dispositivo.assign', code: 'wrong-code' },
    ]);
    expect(calls.some((c) => c.sql.toLowerCase().includes('update dispositivos'))).toBe(false);
    expect(findAuditWriteCall(calls)).toBeUndefined();
  });

  it('device not found -> 404; no write; no audit', async () => {
    const { pool, calls } = makePoolFake({
      responses: [{ match: 'FROM dispositivos', rows: [] }],
    });
    const { otp } = makeOtpFake({ kind: 'ok', otpId: 'otp-unit-404' });

    const svc = new DispositivosService({ pool, log: FAKE_LOGGER, otp: otp as never });
    await expect(
      svc.assign(ACTOR, DEVICE_ID, { canvasUserId: CANVAS_USER_ID }, '123456', META),
    ).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });

    expect(calls.some((c) => c.sql.toLowerCase().includes('update dispositivos'))).toBe(false);
    expect(findAuditWriteCall(calls)).toBeUndefined();
  });

  it('revoked device -> 409 conflict; no write; no audit; does not leak the serial', async () => {
    const { pool, calls } = makePoolFake({
      responses: [
        { match: 'FROM dispositivos', rows: [revokedRow(DEVICE_ID, DEVICE_SERIAL, null)] },
      ],
    });
    const { otp } = makeOtpFake({ kind: 'ok', otpId: 'otp-unit-revoked' });

    const svc = new DispositivosService({ pool, log: FAKE_LOGGER, otp: otp as never });
    const err: AppError = await svc
      .assign(ACTOR, DEVICE_ID, { canvasUserId: CANVAS_USER_ID }, '123456', META)
      .then(
        () => {
          throw new Error('expected throw');
        },
        (e: unknown) => e as AppError,
      );
    expect(err.code).toBe('conflict');
    expect(err.httpStatus).toBe(409);

    expect(calls.some((c) => c.sql.toLowerCase().includes('update dispositivos'))).toBe(false);
    expect(findAuditWriteCall(calls)).toBeUndefined();
    // The denial must not echo the serial.
    expect(JSON.stringify(err)).not.toContain(DEVICE_SERIAL);
  });

  it('student missing in students_cache -> 422 student_not_found; no write; no audit', async () => {
    const { pool, calls } = makePoolFake({
      responses: [
        { match: 'FROM dispositivos', rows: [activeRow(DEVICE_ID, DEVICE_SERIAL, null)] },
        { match: 'students_cache', rows: [] },
      ],
    });
    const { otp } = makeOtpFake({ kind: 'ok', otpId: 'otp-unit-nf' });

    const svc = new DispositivosService({ pool, log: FAKE_LOGGER, otp: otp as never });
    const err = await svc
      .assign(ACTOR, DEVICE_ID, { canvasUserId: CANVAS_USER_ID }, '123456', META)
      .then(
        () => {
          throw new Error('expected throw');
        },
        (e: unknown) => e as AppError,
      );
    expect(err.code).toBe('student_not_found');
    expect(err.httpStatus).toBe(422);

    expect(calls.some((c) => c.sql.toLowerCase().includes('update dispositivos'))).toBe(false);
    expect(findAuditWriteCall(calls)).toBeUndefined();
  });

  it('inactive student -> 422 student_not_active; no write; no audit', async () => {
    const { pool, calls } = makePoolFake({
      responses: [
        { match: 'FROM dispositivos', rows: [activeRow(DEVICE_ID, DEVICE_SERIAL, null)] },
        { match: 'students_cache', rows: [studentRow(CANVAS_USER_ID, false, STUDENT_INTERNAL_ID)] },
      ],
    });
    const { otp } = makeOtpFake({ kind: 'ok', otpId: 'otp-unit-inactive' });

    const svc = new DispositivosService({ pool, log: FAKE_LOGGER, otp: otp as never });
    const err = await svc
      .assign(ACTOR, DEVICE_ID, { canvasUserId: CANVAS_USER_ID }, '123456', META)
      .then(
        () => {
          throw new Error('expected throw');
        },
        (e: unknown) => e as AppError,
      );
    expect(err.code).toBe('student_not_active');
    expect(err.httpStatus).toBe(422);

    expect(calls.some((c) => c.sql.toLowerCase().includes('update dispositivos'))).toBe(false);
    expect(findAuditWriteCall(calls)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// unassign()
// ---------------------------------------------------------------------------

describe('DispositivosService.unassign (unit, mocked pool/otp/audit)', () => {
  it('happy path: clears assigned_student_id; writes audit with before/after and otpId', async () => {
    const { pool, calls } = makePoolFake({
      responses: [
        {
          match: 'FROM dispositivos',
          rows: [activeRow(DEVICE_ID, DEVICE_SERIAL, ASSIGNED_STUDENT_ID)],
        },
        {
          match: 'UPDATE dispositivos',
          rows: [activeRow(DEVICE_ID, DEVICE_SERIAL, null)],
        },
      ],
    });
    const { otp, verifyCalls } = makeOtpFake({ kind: 'ok', otpId: 'otp-unit-unassign' });

    const svc = new DispositivosService({ pool, log: FAKE_LOGGER, otp: otp as never });
    const result = await svc.unassign(ACTOR, DEVICE_ID, '123456', META);

    expect(verifyCalls).toEqual([
      { subject: ACTOR, scope: 'dispositivo.unassign', code: '123456' },
    ]);

    const updateCall = findSql(calls, 'update dispositivos');
    expect(updateCall).toBeDefined();
    expect(updateCall?.params).toEqual([DEVICE_ID, null]);

    const auditCall = findAuditWriteCall(calls);
    expect(auditCall).toBeDefined();
    const params = auditCall?.params ?? [];
    expect(params[2]).toBe('dispositivo.unassign');
    expect(params[7]).toBe('otp-unit-unassign');
    const before = JSON.parse(String(params[5])) as { assignedStudentId: number | null };
    const after = JSON.parse(String(params[6])) as { assignedStudentId: number | null };
    expect(before.assignedStudentId).toBe(ASSIGNED_STUDENT_ID);
    expect(after.assignedStudentId).toBeNull();

    expect(result.assignedStudentId).toBeNull();
  });

  it('missing OTP -> 401 otp_required; no repo write; no audit', async () => {
    const { pool, calls } = makePoolFake({
      responses: [
        {
          match: 'FROM dispositivos',
          rows: [activeRow(DEVICE_ID, DEVICE_SERIAL, ASSIGNED_STUDENT_ID)],
        },
      ],
    });
    const { otp } = makeOtpFake({ kind: 'ok', otpId: 'unreachable' });

    const svc = new DispositivosService({ pool, log: FAKE_LOGGER, otp: otp as never });
    await expect(svc.unassign(ACTOR, DEVICE_ID, undefined, META)).rejects.toMatchObject({
      code: 'otp_required',
      httpStatus: 401,
    });
    expect(calls.some((c) => c.sql.toLowerCase().includes('update dispositivos'))).toBe(false);
    expect(findAuditWriteCall(calls)).toBeUndefined();
  });

  it('rejected OTP -> 401 otp_invalid; no repo write; no audit', async () => {
    const { pool, calls } = makePoolFake({
      responses: [
        {
          match: 'FROM dispositivos',
          rows: [activeRow(DEVICE_ID, DEVICE_SERIAL, ASSIGNED_STUDENT_ID)],
        },
      ],
    });
    const { otp, verifyCalls } = makeOtpFake({ kind: 'rejected', reason: 'invalid' });

    const svc = new DispositivosService({ pool, log: FAKE_LOGGER, otp: otp as never });
    await expect(svc.unassign(ACTOR, DEVICE_ID, 'wrong', META)).rejects.toMatchObject({
      code: 'otp_invalid',
      httpStatus: 401,
    });
    expect(verifyCalls).toEqual([
      { subject: ACTOR, scope: 'dispositivo.unassign', code: 'wrong' },
    ]);
    expect(calls.some((c) => c.sql.toLowerCase().includes('update dispositivos'))).toBe(false);
    expect(findAuditWriteCall(calls)).toBeUndefined();
  });

  it('device not found -> 404; no write; no audit', async () => {
    const { pool, calls } = makePoolFake({ responses: [{ match: 'FROM dispositivos', rows: [] }] });
    const { otp } = makeOtpFake({ kind: 'ok', otpId: 'otp-unit-unassign-404' });

    const svc = new DispositivosService({ pool, log: FAKE_LOGGER, otp: otp as never });
    await expect(svc.unassign(ACTOR, DEVICE_ID, '123456', META)).rejects.toMatchObject({
      code: 'not_found',
      httpStatus: 404,
    });
    expect(calls.some((c) => c.sql.toLowerCase().includes('update dispositivos'))).toBe(false);
    expect(findAuditWriteCall(calls)).toBeUndefined();
  });

  it('already unassigned -> 409 device_not_assigned; no write; no audit', async () => {
    // The pre-state shows assigned_student_id is already NULL. The service
    // must refuse the no-op so the audit log does not record a phantom
    // ownership change.
    const { pool, calls } = makePoolFake({
      responses: [
        { match: 'FROM dispositivos', rows: [activeRow(DEVICE_ID, DEVICE_SERIAL, null)] },
      ],
    });
    const { otp } = makeOtpFake({ kind: 'ok', otpId: 'otp-unit-unassign-409' });

    const svc = new DispositivosService({ pool, log: FAKE_LOGGER, otp: otp as never });
    const err = await svc
      .unassign(ACTOR, DEVICE_ID, '123456', META)
      .then(
        () => {
          throw new Error('expected throw');
        },
        (e: unknown) => e as AppError,
      );
    expect(err.code).toBe('device_not_assigned');
    expect(err.httpStatus).toBe(409);
    expect(calls.some((c) => c.sql.toLowerCase().includes('update dispositivos'))).toBe(false);
    expect(findAuditWriteCall(calls)).toBeUndefined();
  });

  it('unassign is allowed on a revoked device (clearing an owner is always fail-closed-safe)', async () => {
    // A revoked device may still hold a stale assigned_student_id (the FK
    // is ON DELETE SET NULL and only setStatus-style ops clear it). The
    // service must allow the admin to clear it so the audit trail is
    // clean — this differs from assign(), which refuses revoked devices.
    const { pool, calls } = makePoolFake({
      responses: [
        { match: 'FROM dispositivos', rows: [revokedRow(DEVICE_ID, DEVICE_SERIAL, ASSIGNED_STUDENT_ID)] },
        { match: 'UPDATE dispositivos', rows: [revokedRow(DEVICE_ID, DEVICE_SERIAL, null)] },
      ],
    });
    const { otp } = makeOtpFake({ kind: 'ok', otpId: 'otp-unit-unassign-revoked' });

    const svc = new DispositivosService({ pool, log: FAKE_LOGGER, otp: otp as never });
    const result = await svc.unassign(ACTOR, DEVICE_ID, '123456', META);

    expect(calls.some((c) => c.sql.toLowerCase().includes('update dispositivos'))).toBe(true);
    expect(findAuditWriteCall(calls)).toBeDefined();
    expect(result.assignedStudentId).toBeNull();
  });
});
