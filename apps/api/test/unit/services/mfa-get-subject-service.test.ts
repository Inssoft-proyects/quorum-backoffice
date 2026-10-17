/**
 * MFA `get-subject` service — fail-closed policy-order unit tests.
 *
 * Exercises `MfaGetSubjectService.resolve()` in isolation against a
 * fake `MfaGetSubjectRepoLike`. The service is the single point
 * where the deny.* codes are produced from the marbete lookup, the
 * student hydration, and the device authorization check, so this file
 * locks down the policy order end-to-end:
 *
 *   1. marbete not found / revoked / inactive        → deny.marbete_unknown
 *   2. marbete.assigned_student_id IS NULL           → deny.student_inactive
 *   3. student missing / is_active = false           → deny.student_inactive
 *   4. device not found / revoked                    → deny.device_unknown
 *   5. happy path (device active + non-revoked)      → { canvasUserId, matricula }
 *
 * Side contracts:
 *
 *   - The repo receives the sha256 HASH of the marbete code, never
 *     the raw code (asserted by `calls.marbete`).
 *   - The raw marbete code and raw serial never appear in the deny
 *     envelope.
 *   - `matricula` is passed through as-is (null stays null).
 *   - The policy short-circuits: a marbete deny never touches the
 *     student / device lookups.
 */
import { MfaAuthenticateError } from '../../../src/services/mfa-authenticate-service';
import {
  MfaGetSubjectService,
  type MfaGetSubjectRepoLike,
} from '../../../src/services/mfa-get-subject-service';
import { hashMarbeteCode } from '../../../src/lib/marbete-code';
import type {
  MfaMarbeteRow,
  MfaStudentRow,
  MfaDeviceRow,
} from '../../../src/repositories/pg-mfa-repo';

const RAW_CODE = 'VALIDO-2609982468';
const RAW_SERIAL = 'f401e1afcfd09b16';
const OTHER_SERIAL = 'f401e1afcfd0999';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

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
    sis_id: 'A00001',
    is_active: true,
    ...overrides,
  };
}

function makeDeviceRow(overrides: Partial<MfaDeviceRow> = {}): MfaDeviceRow {
  // Fase 2 retired `dispositivos.assigned_student_id`; the
  // device is now a shared approved allowlist (no per-row owner
  // column). The default row mirrors the original "happy" path.
  return {
    id: 200,
    serial_number: RAW_SERIAL,
    status: 'active',
    revoked_at: null,
    ...overrides,
  };
}

interface RepoHarness {
  repo: MfaGetSubjectRepoLike;
  calls: { marbete: string[]; student: number[]; device: string[] };
}

function makeRepo(opts: {
  marbete?: MfaMarbeteRow | null;
  student?: MfaStudentRow | null;
  device?: MfaDeviceRow | null;
}): RepoHarness {
  const calls = { marbete: [] as string[], student: [] as number[], device: [] as string[] };
  const repo: MfaGetSubjectRepoLike = {
    findMarbeteByCodeHash: jest.fn(async (h: string) => {
      calls.marbete.push(h);
      return opts.marbete ?? null;
    }),
    findStudentById: jest.fn(async (id: number) => {
      calls.student.push(id);
      return opts.student ?? null;
    }),
    findDeviceBySerialNumber: jest.fn(async (s: string) => {
      calls.device.push(s);
      return opts.device ?? null;
    }),
  };
  return { repo, calls };
}

function makeService(repo: MfaGetSubjectRepoLike): MfaGetSubjectService {
  return new MfaGetSubjectService({
    pool: {} as unknown as import('pg').Pool,
    repoFactory: () => repo,
  });
}

async function denyCodeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof MfaAuthenticateError) return err.code;
    throw err;
  }
  throw new Error('expected the promise to reject with MfaAuthenticateError');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('MfaGetSubjectService.resolve — policy order', () => {
  it('happy path: active marbete + active student + approved device → { canvasUserId, matricula }', async () => {
    const { repo, calls } = makeRepo({
      marbete: makeMarbeteRow(),
      student: makeStudentRow(),
      device: makeDeviceRow(),
    });
    const svc = makeService(repo);

    const result = await svc.resolve({ marbeteCode: RAW_CODE, serialNumber: RAW_SERIAL });

    expect(result).toEqual({ canvasUserId: 7001, matricula: 'A00001' });
    // The repo receives the sha256 hash, never the raw code.
    expect(calls.marbete).toEqual([hashMarbeteCode(RAW_CODE)]);
    expect(calls.marbete[0]).not.toBe(RAW_CODE);
    expect(calls.student).toEqual([100]);
    expect(calls.device).toEqual([RAW_SERIAL]);
  });

  it('sis_id IS NULL → deny.dependency_fail (B5 S5: pass-through as null is no longer correct)', async () => {
    // B5 / S5 contract change: the previous behaviour
    // passed `matricula: null` through to the caller.
    // That return shape let a S2S caller issue OTPs for
    // a student the downstream Jitsi proxy could not
    // label. The new contract fails closed with
    // `deny.dependency_fail` so the caller must respect
    // the operator decision "denegar si null".
    const { repo } = makeRepo({
      marbete: makeMarbeteRow(),
      student: makeStudentRow({ sis_id: null }),
      device: makeDeviceRow(),
    });
    let caught: unknown;
    try {
      await makeService(repo).resolve({
        marbeteCode: RAW_CODE,
        serialNumber: RAW_SERIAL,
      });
      throw new Error('expected_MfaAuthenticateError');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MfaAuthenticateError);
    expect(caught).toMatchObject({ code: 'deny.dependency_fail' });
  });

  it('marbete not found → deny.marbete_unknown (short-circuits)', async () => {
    const { repo, calls } = makeRepo({ marbete: null });
    const code = await denyCodeOf(
      makeService(repo).resolve({ marbeteCode: RAW_CODE, serialNumber: RAW_SERIAL }),
    );
    expect(code).toBe('deny.marbete_unknown');
    expect(calls.student).toHaveLength(0);
    expect(calls.device).toHaveLength(0);
  });

  it.each(['revoked', 'inactive'] as const)(
    'marbete status=%s → deny.marbete_unknown (indistinguishable from not-found)',
    async (status) => {
      const { repo } = makeRepo({
        marbete: makeMarbeteRow({ status }),
        student: makeStudentRow(),
        device: makeDeviceRow(),
      });
      const code = await denyCodeOf(
        makeService(repo).resolve({ marbeteCode: RAW_CODE, serialNumber: RAW_SERIAL }),
      );
      expect(code).toBe('deny.marbete_unknown');
    },
  );

  it('marbete with assigned_student_id = null → deny.student_inactive (no student lookup)', async () => {
    const { repo, calls } = makeRepo({
      marbete: makeMarbeteRow({ assigned_student_id: null }),
    });
    const code = await denyCodeOf(
      makeService(repo).resolve({ marbeteCode: RAW_CODE, serialNumber: RAW_SERIAL }),
    );
    expect(code).toBe('deny.student_inactive');
    expect(calls.student).toHaveLength(0);
    expect(calls.device).toHaveLength(0);
  });

  it('student missing → deny.student_inactive', async () => {
    const { repo } = makeRepo({
      marbete: makeMarbeteRow(),
      student: null,
      device: makeDeviceRow(),
    });
    const code = await denyCodeOf(
      makeService(repo).resolve({ marbeteCode: RAW_CODE, serialNumber: RAW_SERIAL }),
    );
    expect(code).toBe('deny.student_inactive');
  });

  it('student is_active = false → deny.student_inactive (no device lookup)', async () => {
    const { repo, calls } = makeRepo({
      marbete: makeMarbeteRow(),
      student: makeStudentRow({ is_active: false }),
      device: makeDeviceRow(),
    });
    const code = await denyCodeOf(
      makeService(repo).resolve({ marbeteCode: RAW_CODE, serialNumber: RAW_SERIAL }),
    );
    expect(code).toBe('deny.student_inactive');
    expect(calls.device).toHaveLength(0);
  });

  it('device not found → deny.device_unknown', async () => {
    const { repo } = makeRepo({
      marbete: makeMarbeteRow(),
      student: makeStudentRow(),
      device: null,
    });
    const code = await denyCodeOf(
      makeService(repo).resolve({ marbeteCode: RAW_CODE, serialNumber: OTHER_SERIAL }),
    );
    expect(code).toBe('deny.device_unknown');
  });

  it('device revoked (status) → deny.device_unknown', async () => {
    const { repo } = makeRepo({
      marbete: makeMarbeteRow(),
      student: makeStudentRow(),
      device: makeDeviceRow({ status: 'revoked', revoked_at: new Date() }),
    });
    const code = await denyCodeOf(
      makeService(repo).resolve({ marbeteCode: RAW_CODE, serialNumber: RAW_SERIAL }),
    );
    expect(code).toBe('deny.device_unknown');
  });

  it('device with revoked_at set → deny.device_unknown', async () => {
    const { repo } = makeRepo({
      marbete: makeMarbeteRow(),
      student: makeStudentRow(),
      device: makeDeviceRow({ revoked_at: new Date() }),
    });
    const code = await denyCodeOf(
      makeService(repo).resolve({ marbeteCode: RAW_CODE, serialNumber: RAW_SERIAL }),
    );
    expect(code).toBe('deny.device_unknown');
  });

  it('device with active + non-revoked → resolves (shared device allowlist; fase 2 retired the per-row owner column)', async () => {
    // The previous contract tested `device.assigned_student_id = null`;
    // fase 2 retired the column. Any active, non-revoked device now
    // resolves the same way.
    const { repo } = makeRepo({
      marbete: makeMarbeteRow(),
      student: makeStudentRow(),
      device: makeDeviceRow(),
    });
    const result = await makeService(repo).resolve({
      marbeteCode: RAW_CODE,
      serialNumber: RAW_SERIAL,
    });
    expect(result).toEqual({ canvasUserId: 7001, matricula: 'A00001' });
  });

  it('device with active + non-revoked → resolves regardless of (now-absent) owner (binding not enforced)', async () => {
    // The previous contract tested `device.assigned_student_id = 999`;
    // fase 2 retired the column. Any active, non-revoked device now
    // resolves regardless of any (now-absent) owner column.
    const { repo } = makeRepo({
      marbete: makeMarbeteRow(),
      student: makeStudentRow({ id: 100 }),
      device: makeDeviceRow(),
    });
    const result = await makeService(repo).resolve({
      marbeteCode: RAW_CODE,
      serialNumber: RAW_SERIAL,
    });
    expect(result).toEqual({ canvasUserId: 7001, matricula: 'A00001' });
  });

  it('deny envelope never contains the raw marbete code or the raw serial', async () => {
    const { repo } = makeRepo({ marbete: null });
    expect.assertions(2);
    try {
      await makeService(repo).resolve({
        marbeteCode: RAW_CODE,
        serialNumber: RAW_SERIAL,
      });
    } catch (err) {
      const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
      expect(serialized).not.toContain(RAW_CODE);
      expect(serialized).not.toContain(RAW_SERIAL);
    }
  });

  // B5 / S5: the get-subject path now enforces the same
  // fail-closed gate as authenticate. A student whose
  // `students_cache.sis_id` is NULL (legacy / synthetic
  // row) MUST be denied with `deny.dependency_fail` so
  // the caller never receives a `matricula: null` answer
  // they could mistake for "no answer yet". The gate
  // runs AFTER the device check (only authorized callers
  // learn that the cache row is missing the matrícula).
  it('B5/S5: sis_id IS NULL → deny.dependency_fail (matrícula absent; gate AFTER device check)', async () => {
    const { repo } = makeRepo({
      marbete: makeMarbeteRow(),
      student: makeStudentRow({ sis_id: null }),
      device: makeDeviceRow(),
    });
    let caught: unknown;
    try {
      await makeService(repo).resolve({
        marbeteCode: RAW_CODE,
        serialNumber: RAW_SERIAL,
      });
      throw new Error('expected_MfaAuthenticateError');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MfaAuthenticateError);
    expect(caught).toMatchObject({ code: 'deny.dependency_fail' });
  });

  it('B5/S5 (precedence): a null-matrícula student with no device still denies device_unknown (gate runs AFTER device check)', async () => {
    // Triangulate the gate placement: the device check
    // runs BEFORE the matrícula gate, so a no-device +
    // null-matrícula student gets `deny.device_unknown`,
    // NOT `deny.dependency_fail`. Locks the
    // precedence so a future refactor that moves the
    // gate above the device check would break this test.
    const { repo } = makeRepo({
      marbete: makeMarbeteRow(),
      student: makeStudentRow({ sis_id: null }),
      device: null,
    });
    const code = await denyCodeOf(
      makeService(repo).resolve({
        marbeteCode: RAW_CODE,
        serialNumber: OTHER_SERIAL,
      }),
    );
    expect(code).toBe('deny.device_unknown');
  });

  it('B5/S5 (inverse): happy path with a real sis_id still completes (matrícula round-trips)', async () => {
    const { repo } = makeRepo({
      marbete: makeMarbeteRow(),
      student: makeStudentRow({ sis_id: 'TOPGR4' }),
      device: makeDeviceRow(),
    });
    const result = await makeService(repo).resolve({
      marbeteCode: RAW_CODE,
      serialNumber: RAW_SERIAL,
    });
    expect(result).toEqual({ canvasUserId: 7001, matricula: 'TOPGR4' });
  });

  it('B5/S5 (leak guard): the deny envelope never contains the raw marbete code or serial on the matrícula gate', async () => {
    const { repo } = makeRepo({
      marbete: makeMarbeteRow(),
      student: makeStudentRow({ sis_id: null }),
      device: makeDeviceRow(),
    });
    expect.assertions(2);
    try {
      await makeService(repo).resolve({
        marbeteCode: RAW_CODE,
        serialNumber: RAW_SERIAL,
      });
    } catch (err) {
      const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
      expect(serialized).not.toContain(RAW_CODE);
      expect(serialized).not.toContain(RAW_SERIAL);
    }
  });
});
