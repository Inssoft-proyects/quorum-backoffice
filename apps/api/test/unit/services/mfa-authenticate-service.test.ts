/**
 * M1 / MFA authentication service — fail-closed policy-order unit tests.
 *
 * Exercises `MfaAuthenticateService.authenticate()` in isolation against
 * a fake `MfaRepoLike` and a fake `MfaOtpLike`. The service is the
 * single point where the deny.* codes are produced from the marbete
 * lookup, the device ownership check, and the OTP outcome, so this file
 * locks down the policy order end-to-end:
 *
 *   1. marbete not found / revoked / deleted         → deny.marbete_unknown
 *   2. marbete.assigned_student_id IS NULL          → deny.student_inactive
 *   3. student.is_active = false                    → deny.student_inactive
 *   4. device not found / revoked / unassigned      → deny.device_unknown
 *   5. device assigned to a DIFFERENT student       → deny.device_not_bound_to_student
 *   6. OTP verify {ok:false, reason:'invalid'}      → deny.otp_invalid
 *   7. OTP verify {ok:false, reason:'locked'}       → deny.dependency_fail
 *   8. OTP verify {ok:false, reason:'unknown'}      → deny.dependency_fail
 *   9. OTP verify throws (service_unavailable etc.) → deny.dependency_fail
 *      (the service must NEVER crash on a dependency failure)
 *  10. happy path                                   → success + audit row
 *
 * Side contracts:
 *
 *   - OTP verify is invoked with subject = String(canvas_user_id) and
 *     scope = MFA_AUTHENTICATE_OTP_SCOPE = 'mfa.access'.
 *   - The deny envelope NEVER contains the raw marbete code, the raw
 *     serial, or the raw OTP.
 *   - The audit row carries canvas_user_id (entity_id), the denormalized
 *     student name/email, and the deny code; it NEVER carries the raw
 *     code/serial/OTP.
 */
import { MFA_AUTHENTICATE_OTP_SCOPE } from '@quorum-backoffice/shared';
import { hashMarbeteCode } from '../../../src/lib/marbete-code';
import {
  MfaAuthenticateError,
  MfaAuthenticateService,
  type MfaOtpLike,
  type MfaRepoLike,
} from '../../../src/services/mfa-authenticate-service';
import type {
  MfaMarbeteRow,
  MfaStudentRow,
  MfaDeviceRow,
  MfaStudentSessionRow,
} from '../../../src/repositories/pg-mfa-repo';
import type { VerifyOtpResult } from '@quorum-backoffice/shared';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface OtpCall {
  subject: string;
  scope: string;
  code: string;
}

type NextOtpResult =
  | { kind: 'ok'; otpId: string }
  | { kind: 'fail'; reason: 'invalid' | 'locked' | 'unknown' | 'expired' | 'rate_limited' }
  | { kind: 'throw'; error: unknown };

function makeOtpFake(): {
  calls: OtpCall[];
  setNext: (
    result:
      | { ok: true; otpId: string }
      | { ok: false; reason: 'invalid' | 'locked' | 'unknown' | 'expired' | 'rate_limited' }
      | { throw: true; error: unknown },
  ) => void;
  verify: MfaOtpLike['verify'];
} {
  const calls: OtpCall[] = [];
  const queue: NextOtpResult[] = [];
  return {
    calls,
    setNext: (result) => {
      if ('throw' in result) queue.push({ kind: 'throw', error: result.throw });
      else if (result.ok) queue.push({ kind: 'ok', otpId: result.otpId });
      else queue.push({ kind: 'fail', reason: result.reason });
    },
    verify: jest.fn(async (args: { subject: string; scope: string; code: string }): Promise<VerifyOtpResult> => {
      calls.push({ subject: args.subject, scope: args.scope, code: args.code });
      const next = queue.shift();
      if (!next) throw new Error('otp_fake_no_next_result');
      if (next.kind === 'throw') throw next.error;
      if (next.kind === 'ok') return { ok: true, otpId: next.otpId };
      return { ok: false, reason: next.reason };
    }),
  };
}

function makeMarbeteRow(overrides: Partial<MfaMarbeteRow> = {}): MfaMarbeteRow {
  return {
    id: 1,
    public_uid: 'm-TESTUID',
    status: 'active',
    assigned_student_id: 100,
    deleted_at: null,
    ...overrides,
  };
}

function makeStudentRow(overrides: Partial<MfaStudentRow> = {}): MfaStudentRow {
  return {
    id: 100,
    canvas_user_id: 7001,
    full_name: 'Marie Curie',
    email: 'marie@example.test',
    is_active: true,
    ...overrides,
  };
}

function makeDeviceRow(overrides: Partial<MfaDeviceRow> = {}): MfaDeviceRow {
  return {
    id: 200,
    serial_number: 'SN-UNIT-1',
    status: 'active',
    revoked_at: null,
    assigned_student_id: 100,
    ...overrides,
  };
}

function makeSessionRow(overrides: Partial<MfaStudentSessionRow> = {}): MfaStudentSessionRow {
  return {
    id: 'sess-token-12345678901234567890',
    canvas_user_id: 7001,
    kind: 'student',
    expires_at: new Date(Date.now() + 3600_000),
    created_at: new Date(),
    ...overrides,
  };
}

interface AuditEntry {
  actorId: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata?: Record<string, unknown>;
  afterJson?: unknown;
  otpId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

interface ServiceBuildResult {
  service: MfaAuthenticateService;
  otp: ReturnType<typeof makeOtpFake>;
  audit: AuditEntry[];
  repo: {
    setMarbete: (row: MfaMarbeteRow | null) => void;
    setStudent: (row: MfaStudentRow | null) => void;
    setDevice: (row: MfaDeviceRow | null) => void;
    sessionInserts: Array<{
      id: string;
      canvasUserId: number;
      expiresAt: Date;
      ip: string | null;
      userAgent: string | null;
    }>;
  };
}

function buildService(opts: {
  marbete?: MfaMarbeteRow | null;
  student?: MfaStudentRow | null;
  device?: MfaDeviceRow | null;
} = {}): ServiceBuildResult {
  const otp = makeOtpFake();
  const audit: AuditEntry[] = [];

  let marbeteNext: MfaMarbeteRow | null = opts.marbete !== undefined ? opts.marbete : makeMarbeteRow();
  let studentNext: MfaStudentRow | null = opts.student !== undefined ? opts.student : makeStudentRow();
  let deviceNext: MfaDeviceRow | null = opts.device !== undefined ? opts.device : makeDeviceRow();
  const sessionInserts: ServiceBuildResult['repo']['sessionInserts'] = [];

  const fakeRepo: MfaRepoLike = {
    findMarbeteByCodeHash: jest.fn(async () => marbeteNext),
    findStudentById: jest.fn(async () => studentNext),
    findDeviceBySerialNumber: jest.fn(async () => deviceNext),
    insertStudentSession: jest.fn(async (args) => {
      sessionInserts.push(args);
      return makeSessionRow({
        id: args.id,
        canvas_user_id: args.canvasUserId,
        expires_at: args.expiresAt,
      });
    }),
  };

  // The service's `AuditService` writes go through a real
  // `pg.Pool`-shaped fake. The audit service is constructed with
  // `new AuditService(this.pool)`; the only method it calls on
  // the pool is `query()`. Stub it so each write pushes onto
  // the `audit` array.
  const fakePool = {
    query: jest.fn(async (_sql: string, params?: unknown[]) => {
      // The audit service writes use a parameterized query with
      // 10 placeholders; we capture the actorId, action,
      // entityType, entityId, and the JSONB metadata (slot 7
      // per the audit-service INSERT).
      const [
        actorId,
        _actorEmail,
        action,
        entityType,
        entityId,
        _beforeJsonb,
        afterJsonbStr,
        otpId,
        ip,
        userAgent,
      ] = (params ?? []) as [string, unknown, string, string | null, string | null, unknown, string | null, string | null, string | null, string | null];
      let metadata: Record<string, unknown> | undefined;
      if (typeof afterJsonbStr === 'string' && afterJsonbStr.length > 0) {
        try {
          metadata = JSON.parse(afterJsonbStr) as Record<string, unknown>;
        } catch {
          // leave metadata undefined on a parse failure
        }
      }
      audit.push({
        actorId,
        action,
        entityType,
        entityId,
        metadata,
        otpId,
        ip,
        userAgent,
      });
      return { rows: [], rowCount: 1 } as never;
    }),
  };

  const service = new MfaAuthenticateService({
    pool: fakePool as never,
    // The service logs at info/warn/error; the smoke tests don't
    // assert on log content but the logger MUST expose the three
    // methods the service touches.
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
      fatal: () => undefined,
      child: () => ({}) as never,
      level: 'silent',
    } as never,
    otp: otp as unknown as MfaOtpLike,
    sessionTtlSeconds: 3600,
    repoFactory: () => fakeRepo,
  });

  return {
    service,
    otp,
    audit,
    repo: {
      setMarbete: (row) => {
        marbeteNext = row;
      },
      setStudent: (row) => {
        studentNext = row;
      },
      setDevice: (row) => {
        deviceNext = row;
      },
      sessionInserts,
    },
  };
}

const META = { ip: '127.0.0.1', userAgent: 'jest-unit/1.0' };

function baseInput() {
  return {
    marbeteCode: 'PLAINTEXT-CODE-12345',
    serialNumber: 'SN-UNIT-1',
    otp: '123456',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MfaAuthenticateService.authenticate — policy order (unit, mocked OTP/Repo)', () => {
  let built: ServiceBuildResult;
  beforeEach(() => {
    built = buildService();
  });

  // ---- (1) marbete_unknown ----

  it('1a) deny.marbete_unknown when the marbete row is not found', async () => {
    built.repo.setMarbete(null);
    await expect(built.service.authenticate(baseInput(), META)).rejects.toBeInstanceOf(
      MfaAuthenticateError,
    );
    await expect(built.service.authenticate(baseInput(), META)).rejects.toMatchObject({
      code: 'deny.marbete_unknown',
    });
    expect(built.otp.calls).toHaveLength(0);
  });

  it('1b) deny.marbete_unknown when the marbete status is revoked (collapses to unknown)', async () => {
    built.repo.setMarbete(makeMarbeteRow({ status: 'revoked' }));
    await expect(built.service.authenticate(baseInput(), META)).rejects.toMatchObject({
      code: 'deny.marbete_unknown',
    });
    expect(built.otp.calls).toHaveLength(0);
  });

  it('1c) deny.marbete_unknown when the marbete deleted_at is set (repo filter)', async () => {
    // The repo's findMarbeteByCodeHash filters out soft-deleted rows
    // at the SQL level; simulating the same behavior at the unit
    // level by returning null.
    built.repo.setMarbete(null);
    await expect(built.service.authenticate(baseInput(), META)).rejects.toMatchObject({
      code: 'deny.marbete_unknown',
    });
  });

  // ---- (2) student_inactive (no assigned student) ----

  it('2a) deny.student_inactive when the marbete has no assigned_student_id', async () => {
    built.repo.setMarbete(makeMarbeteRow({ assigned_student_id: null }));
    await expect(built.service.authenticate(baseInput(), META)).rejects.toMatchObject({
      code: 'deny.student_inactive',
    });
    expect(built.otp.calls).toHaveLength(0);
  });

  // ---- (3) student_inactive (is_active = false) ----

  it('2b) deny.student_inactive when the student row is not found', async () => {
    built.repo.setStudent(null);
    await expect(built.service.authenticate(baseInput(), META)).rejects.toMatchObject({
      code: 'deny.student_inactive',
    });
    expect(built.otp.calls).toHaveLength(0);
  });

  it('2c) deny.student_inactive when student.is_active is false', async () => {
    built.repo.setStudent(makeStudentRow({ is_active: false }));
    await expect(built.service.authenticate(baseInput(), META)).rejects.toMatchObject({
      code: 'deny.student_inactive',
    });
    expect(built.otp.calls).toHaveLength(0);
  });

  // ---- (4) device_unknown ----

  it('3a) deny.device_unknown when the device is not found', async () => {
    built.repo.setDevice(null);
    await expect(built.service.authenticate(baseInput(), META)).rejects.toMatchObject({
      code: 'deny.device_unknown',
    });
    expect(built.otp.calls).toHaveLength(0);
  });

  it('3b) deny.device_unknown when the device is revoked', async () => {
    built.repo.setDevice(
      makeDeviceRow({ status: 'revoked', revoked_at: new Date() }),
    );
    await expect(built.service.authenticate(baseInput(), META)).rejects.toMatchObject({
      code: 'deny.device_unknown',
    });
    expect(built.otp.calls).toHaveLength(0);
  });

  it('3c) deny.device_unknown when the device is unassigned (assigned_student_id IS NULL)', async () => {
    built.repo.setDevice(makeDeviceRow({ assigned_student_id: null }));
    await expect(built.service.authenticate(baseInput(), META)).rejects.toMatchObject({
      code: 'deny.device_unknown',
    });
    expect(built.otp.calls).toHaveLength(0);
  });

  // ---- (5) device_not_bound_to_student ----

  it('4) deny.device_not_bound_to_student when the device is bound to a different student', async () => {
    built.repo.setDevice(makeDeviceRow({ assigned_student_id: 999 }));
    await expect(built.service.authenticate(baseInput(), META)).rejects.toMatchObject({
      code: 'deny.device_not_bound_to_student',
    });
    expect(built.otp.calls).toHaveLength(0);
  });

  // ---- (6..9) OTP outcomes ----

  it('5a) deny.otp_invalid when OTP verify returns {ok:false, reason:"invalid"}', async () => {
    built.otp.setNext({ ok: false, reason: 'invalid' });
    await expect(built.service.authenticate(baseInput(), META)).rejects.toMatchObject({
      code: 'deny.otp_invalid',
    });
  });

  it('5b) deny.dependency_fail when OTP verify returns {ok:false, reason:"locked"}', async () => {
    built.otp.setNext({ ok: false, reason: 'locked' });
    await expect(built.service.authenticate(baseInput(), META)).rejects.toMatchObject({
      code: 'deny.dependency_fail',
    });
  });

  it('5c) deny.dependency_fail when OTP verify returns {ok:false, reason:"unknown"}', async () => {
    built.otp.setNext({ ok: false, reason: 'unknown' });
    await expect(built.service.authenticate(baseInput(), META)).rejects.toMatchObject({
      code: 'deny.dependency_fail',
    });
  });

  it('5d) deny.dependency_fail when OTP verify returns {ok:false, reason:"expired"}', async () => {
    built.otp.setNext({ ok: false, reason: 'expired' });
    await expect(built.service.authenticate(baseInput(), META)).rejects.toMatchObject({
      code: 'deny.dependency_fail',
    });
  });

  it('5e) deny.dependency_fail when OTP verify throws (dependency outage)', async () => {
    built.otp.setNext({ throw: true, error: new Error('boom') });
    await expect(built.service.authenticate(baseInput(), META)).rejects.toMatchObject({
      code: 'deny.dependency_fail',
    });
  });

  // ---- (10) happy path ----

  it('6) success path issues a kind="student" session and writes the ok audit row', async () => {
    built.otp.setNext({ ok: true, otpId: 'otp-mfa-unit-happy' });
    const result = await built.service.authenticate(baseInput(), META);
    expect(result.canvasUserId).toBe(7001);
    expect(result.studentName).toBe('Marie Curie');
    expect(result.studentEmail).toBe('marie@example.test');
    expect(result.sessionToken).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // The session row was inserted with the canvas_user_id and
    // the opaque token (the route reads these from the result
    // and turns them into the cookie + response body).
    expect(built.repo.sessionInserts).toHaveLength(1);
    const ins = built.repo.sessionInserts[0]!;
    expect(ins.canvasUserId).toBe(7001);
    expect(ins.id).toBe(result.sessionToken);
    expect(ins.expiresAt.getTime()).toBe(result.expiresAt.getTime());

    // The audit row carries the ok outcome + the denormalized
    // student identity; it MUST NOT contain the raw code / serial
    // / OTP.
    expect(built.audit).toHaveLength(1);
    const row = built.audit[0]!;
    expect(row.actorId).toBe('__mfa__');
    expect(row.action).toBe('student.mfa_authenticate');
    expect(row.entityType).toBe('student');
    expect(row.entityId).toBe('7001');
    expect(row.otpId).toBe('otp-mfa-unit-happy');
    expect(row.metadata?.['outcome']).toBe('ok');
    expect(row.metadata?.['student_name']).toBe('Marie Curie');
    expect(row.metadata?.['student_email']).toBe('marie@example.test');
    const auditJson = JSON.stringify(row);
    expect(auditJson).not.toContain('PLAINTEXT-CODE-12345');
    expect(auditJson).not.toContain('SN-UNIT-1');
    expect(auditJson).not.toContain('123456');
  });

  // ---- side contracts ----

  it('OTP verify is invoked with subject=String(canvas_user_id) and scope=mfa.access', async () => {
    built.otp.setNext({ ok: false, reason: 'invalid' });
    await expect(
      built.service.authenticate(
        { ...baseInput(), serialNumber: 'SN-PROBE' },
        META,
      ),
    ).rejects.toMatchObject({ code: 'deny.otp_invalid' });
    expect(built.otp.calls).toEqual([
      {
        subject: '7001',
        scope: MFA_AUTHENTICATE_OTP_SCOPE,
        code: '123456',
      },
    ]);
    expect(built.otp.calls[0]?.scope).toBe('mfa.access');
  });

  it('marbete lookup receives the sha256 hash of the input code, NOT the raw code', async () => {
    const fakeRepo = {
      findMarbeteByCodeHash: jest.fn(async () => null),
      findStudentById: jest.fn(async () => null),
      findDeviceBySerialNumber: jest.fn(async () => null),
      insertStudentSession: jest.fn(async () => makeSessionRow()),
    } as unknown as MfaRepoLike;
    const fakePool = {
      query: jest.fn(async () => ({ rows: [], rowCount: 1 } as never)),
    };
    const service = new MfaAuthenticateService({
      pool: fakePool as never,
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
        fatal: () => undefined,
        child: () => ({}) as never,
        level: 'silent',
      } as never,
      otp: { verify: jest.fn() } as unknown as MfaOtpLike,
      sessionTtlSeconds: 3600,
      repoFactory: () => fakeRepo,
    });
    await expect(
      service.authenticate(
        { marbeteCode: 'PLAINTEXT-CODE-12345', serialNumber: 'SN-X', otp: '654321' },
        META,
      ),
    ).rejects.toMatchObject({ code: 'deny.marbete_unknown' });
    expect((fakeRepo.findMarbeteByCodeHash as jest.Mock).mock.calls).toEqual([
      [hashMarbeteCode('PLAINTEXT-CODE-12345')],
    ]);
  });

  it('serial-leak guard: every deny envelope never contains the raw code, serial, or OTP', async () => {
    const cases: Array<{
      label: string;
      marbete?: MfaMarbeteRow | null;
      student?: MfaStudentRow | null;
      device?: MfaDeviceRow | null;
      otpProgram?:
        | { ok: true; otpId: string }
        | { ok: false; reason: 'invalid' | 'locked' | 'unknown' | 'expired' | 'rate_limited' }
        | { throw: true; error: unknown };
    }> = [
      { label: 'marbete_unknown', marbete: null },
      { label: 'student_inactive_no_owner', marbete: makeMarbeteRow({ assigned_student_id: null }) },
      { label: 'student_inactive_inactive', student: makeStudentRow({ is_active: false }) },
      { label: 'device_unknown', device: null },
      { label: 'device_not_bound', device: makeDeviceRow({ assigned_student_id: 999 }) },
      { label: 'otp_invalid', otpProgram: { ok: false, reason: 'invalid' } },
      { label: 'dependency_fail_throw', otpProgram: { throw: true, error: new Error('boom') } },
    ];
    for (const c of cases) {
      const built2 = buildService({
        marbete: c.marbete === undefined ? undefined : c.marbete,
        student: c.student === undefined ? undefined : c.student,
        device: c.device === undefined ? undefined : c.device,
      });
      if (c.otpProgram) built2.otp.setNext(c.otpProgram);
      try {
        await built2.service.authenticate(baseInput(), META);
        // happy path: the input is the only thing the
        // service never sees on a deny path, so the assertion
        // is vacuously true (no error was thrown).
      } catch (err) {
        const mfaErr = err as MfaAuthenticateError;
        const wireShape = {
          code: mfaErr.code,
          message: mfaErr.message,
          details: mfaErr.details,
        };
        const serialized = JSON.stringify(wireShape);
        // The raw marbete code, the raw serial, and the raw OTP
        // MUST NOT appear in the deny envelope.
        expect(serialized).not.toContain('PLAINTEXT-CODE-12345');
        expect(serialized).not.toContain('SN-UNIT-1');
        expect(serialized).not.toContain('123456');
        // The audit row MUST NOT contain the raw code/serial/OTP either.
        for (const a of built2.audit) {
          const aJson = JSON.stringify(a);
          expect(aJson).not.toContain('PLAINTEXT-CODE-12345');
          expect(aJson).not.toContain('SN-UNIT-1');
          expect(aJson).not.toContain('123456');
        }
      }
    }
  });

  it('happy path: the session insert receives the canvas_user_id and the opaque token', async () => {
    built.otp.setNext({ ok: true, otpId: 'otp-mfa-session-insert' });
    const result = await built.service.authenticate(baseInput(), META);
    expect(built.repo.sessionInserts).toHaveLength(1);
    const ins = built.repo.sessionInserts[0]!;
    expect(ins.canvasUserId).toBe(7001);
    expect(ins.id).toBe(result.sessionToken);
    expect(ins.ip).toBe('127.0.0.1');
    expect(ins.userAgent).toBe('jest-unit/1.0');
  });

  it('marbete_unknown path: an audit row is written with entity_id="unknown" and the deny code', async () => {
    built.repo.setMarbete(null);
    await expect(built.service.authenticate(baseInput(), META)).rejects.toMatchObject({
      code: 'deny.marbete_unknown',
    });
    // The service still writes a deny audit row (with the
    // student-side fields null and entity_id="unknown") so the
    // operator can reconcile a brute-force sweep across marbete
    // codes against the audit log.
    expect(built.audit).toHaveLength(1);
    const row = built.audit[0]!;
    expect(row.actorId).toBe('__mfa__');
    expect(row.action).toBe('student.mfa_authenticate');
    expect(row.entityType).toBe('student');
    expect(row.entityId).toBe('unknown');
    expect(row.metadata?.['outcome']).toBe('deny.marbete_unknown');
  });
});
