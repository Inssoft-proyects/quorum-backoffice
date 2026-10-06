/**
 * B3.2 / Access-decision service — policy-order unit tests.
 *
 * Exercises `AccessDecisionService.decide()` in isolation against a
 * mocked OtpClient + mocked owner-check repository. The service is the
 * single point where the deny.* codes are produced from the OTP outcome
 * and the device ownership check, so this file locks down the policy
 * order end-to-end:
 *
 *   1. otp_proof missing / empty        → deny.otp_missing
 *   2. OTP verify {ok:false, invalid}   → deny.otp_invalid
 *   3. OTP verify {ok:false, locked}    → deny.lockout
 *   4. OTP verify {ok:false, unknown}   → deny.dependency_fail
 *   5. OTP verify throws (service_unavailable etc.) → deny.dependency_fail
 *      (the decision service must NEVER crash on a dependency failure)
 *   6. owner === false                  → deny.device_unknown
 *      (uniform: never distinguish unknown vs revoked vs wrong owner vs
 *       inactive student; NEVER echo the serial or any device detail)
 *   7. owner === true                   → { decision: 'allow', student_id,
 *                                          room_id?, media_policy? }
 *
 * Side contract:
 *   - OTP verify is invoked with subject = String(input.canvas_user_id)
 *     and scope = ACCESS_DECISION_OTP_SCOPE = 'access.decision'
 *   - The response on EVERY deny path contains neither the device serial
 *     nor any other device detail (no serial-leak guard).
 *   - No audit row is written by the service in B3.2 (audit wiring is
 *     deferred; the OTP consumption itself is the attestation).
 */
import {
  DecisionRequest,
  ACCESS_DECISION_OTP_SCOPE,
} from '@quorum-backoffice/shared';
import { AppError } from '../../src/lib/errors';
import { AccessDecisionService } from '../../src/services/access-decision-service';
import type {
  AccessDecisionDeps,
  AccessDecisionMeta,
} from '../../src/services/access-decision-service';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface OtpCall {
  subject: string;
  scope: string;
  code: string;
}

interface OtpFake {
  calls: OtpCall[];
  /** Program the next verify call to return a specific result. */
  setNext: (
      result:
        | { ok: true; otpId: string }
        | { ok: false; reason: 'invalid' | 'locked' | 'unknown' }
        | { throw: true; error: unknown }
    ) => void;
  /** Inspect the result previously captured by setNext. */
  consumeNext: () => NextOtpResult;
}

type NextOtpResult =
  | { kind: 'ok'; otpId: string }
  | { kind: 'fail'; reason: 'invalid' | 'locked' | 'unknown' }
  | { kind: 'throw'; error: unknown };

function makeOtpFake(): OtpFake {
  const calls: OtpCall[] = [];
  const queue: NextOtpResult[] = [];
  return {
    calls,
    setNext: (result) => {
      if ('throw' in result) queue.push({ kind: 'throw', error: result.throw });
      else if (result.ok) queue.push({ kind: 'ok', otpId: result.otpId });
      else queue.push({ kind: 'fail', reason: result.reason });
    },
    consumeNext: () => {
      const next = queue.shift();
      if (!next) throw new Error('otp_fake_no_next_result');
      return next;
    },
  };
}

interface OwnerFake {
  calls: Array<{ serialNumber: string; canvasUserId: number }>;
  /** Program the next owner-check result. */
  setNext: (result: { owner: boolean; studentId: number | null }) => void;
}

function makeOwnerFake(): OwnerFake {
  let next: { owner: boolean; studentId: number | null } | null = null;
  return {
    calls: [],
    setNext: (result) => {
      next = result;
    },
  };
}

interface ServiceBuildResult {
  service: AccessDecisionService;
  otp: OtpFake;
  owner: OwnerFake;
}

function buildService(): ServiceBuildResult {
  const otp = makeOtpFake();
  const owner = makeOwnerFake();

  const fakeOtpClient = {
    verify: jest.fn(async (args: { subject: string; scope: string; code: string }) => {
      otp.calls.push({ subject: args.subject, scope: args.scope, code: args.code });
      const next = otp.consumeNext();
      if (next.kind === 'throw') throw next.error;
      if (next.kind === 'ok') return { ok: true, otpId: next.otpId };
      return { ok: false, reason: next.reason };
    }),
  };

  // The owner-check fake uses a single-slot `next` set via setNext.
  let ownerNext: { owner: boolean; studentId: number | null } | null = null;
  function nextOwner(): { owner: boolean; studentId: number | null } {
    if (!ownerNext) throw new Error('owner_fake_no_next_result');
    const v = ownerNext;
    ownerNext = null;
    return v;
  }
  owner.setNext = (result) => {
    ownerNext = result;
  };

  const fakeOwnerCheck = jest.fn(
    async (serialNumber: string, canvasUserId: number) => {
      owner.calls.push({ serialNumber, canvasUserId });
      return nextOwner();
    },
  );

  const deps: AccessDecisionDeps = {
    otp: fakeOtpClient as unknown as AccessDecisionDeps['otp'],
    checkOwner: fakeOwnerCheck as unknown as AccessDecisionDeps['checkOwner'],
  };

  const service = new AccessDecisionService(deps);
  return { service, otp, owner };
}

const META: AccessDecisionMeta = { ip: '127.0.0.1', userAgent: 'jest-unit/1.0' };

function baseInput(): DecisionRequest {
  return {
    device_id: 'SN-UNIT-1',
    otp_proof: '123456',
    canvas_user_id: 42,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AccessDecisionService.decide — policy order (unit, mocked OTP/Repo)', () => {
  let built: ServiceBuildResult;
  beforeEach(() => {
    built = buildService();
  });

  it('1) deny.otp_missing when otp_proof is empty (service contract check)', async () => {
    // The shared DTO permits empty `otp_proof` at the wire boundary
    // so this endpoint can map it to `deny.otp_missing` rather than
    // a 400 validation error; the service contract is what we lock.
    const input: DecisionRequest = {
      device_id: 'SN-UNIT-1',
      otp_proof: '',
      canvas_user_id: 42,
    };
    const out = await built.service.decide(input, META);
    expect(out.decision).toBe('deny');
    expect(out.denial).toBe('deny.otp_missing');
    expect(out.student_id).toBeNull();
    // OTP must NOT have been invoked on the missing path; the
    // decision short-circuits BEFORE any dependency call so a
    // misconfigured downstream cannot mask the missing-input bug.
    expect(built.otp.calls).toHaveLength(0);
    // The owner check is also skipped on the missing-otp path: the
    // device serial must never leave the request handler.
    expect(built.owner.calls).toHaveLength(0);
  });

  it('2) deny.otp_invalid when OTP verify returns {ok:false, reason:"invalid"}', async () => {
    built.otp.setNext({ ok: false, reason: 'invalid' });
    const out = await built.service.decide(baseInput(), META);
    expect(out.decision).toBe('deny');
    expect(out.denial).toBe('deny.otp_invalid');
    expect(out.student_id).toBeNull();
    // The device owner check MUST NOT run after an OTP rejection —
    // a failed OTP is the end of the line, and probing the device
    // table with a failed OTP would leak ownership state.
    expect(built.owner.calls).toHaveLength(0);
  });

  it('3) deny.lockout when OTP verify returns {ok:false, reason:"locked"}', async () => {
    built.otp.setNext({ ok: false, reason: 'locked' });
    const out = await built.service.decide(baseInput(), META);
    expect(out.decision).toBe('deny');
    expect(out.denial).toBe('deny.lockout');
    expect(out.student_id).toBeNull();
    expect(built.owner.calls).toHaveLength(0);
  });

  it('4) deny.dependency_fail when OTP verify returns {ok:false, reason:"unknown"}', async () => {
    built.otp.setNext({ ok: false, reason: 'unknown' });
    const out = await built.service.decide(baseInput(), META);
    expect(out.decision).toBe('deny');
    expect(out.denial).toBe('deny.dependency_fail');
    expect(out.student_id).toBeNull();
    expect(built.owner.calls).toHaveLength(0);
  });

  it('5) deny.dependency_fail when OTP verify raises (dependency outage)', async () => {
    // Mirrors OtpClient throwing AppError.serviceUnavailable on a
    // timeout or 5xx. The decision service must NEVER propagate
    // the exception — the caller of /api/v1/access-decisions gets
    // a clean deny envelope instead of a 500.
    built.otp.setNext({ throw: true, error: AppError.serviceUnavailable('otp_service_5xx') });
    const out = await built.service.decide(baseInput(), META);
    expect(out.decision).toBe('deny');
    expect(out.denial).toBe('deny.dependency_fail');
    expect(out.student_id).toBeNull();
    expect(built.owner.calls).toHaveLength(0);
  });

  it('5b) deny.dependency_fail when OTP verify throws an arbitrary Error (never crashes)', async () => {
    built.otp.setNext({ throw: true, error: new Error('boom') });
    const out = await built.service.decide(baseInput(), META);
    expect(out.decision).toBe('deny');
    expect(out.denial).toBe('deny.dependency_fail');
    expect(out.student_id).toBeNull();
    expect(built.owner.calls).toHaveLength(0);
  });

  it('6) deny.device_unknown when the owner check returns owner:false', async () => {
    built.otp.setNext({ ok: true, otpId: 'otp-allow-1' });
    built.owner.setNext({ owner: false, studentId: null });
    const out = await built.service.decide(baseInput(), META);
    expect(out.decision).toBe('deny');
    expect(out.denial).toBe('deny.device_unknown');
    expect(out.student_id).toBeNull();
  });

  it('6b) deny.device_unknown is uniform: the response never contains the device serial', async () => {
    built.otp.setNext({ ok: true, otpId: 'otp-allow-1' });
    built.owner.setNext({ owner: false, studentId: null });
    const out = await built.service.decide(baseInput(), META);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('SN-UNIT-1');
    // Also: the response must not leak the (mocked) owner-check
    // studentId, even when it's null. The JSON representation of
    // null is the literal "null" and never contains digits.
    expect(serialized).not.toMatch(/\bstudentId\b/);
  });

  it('7) allow path returns decision=allow with the resolved student_id and passthrough fields', async () => {
    built.otp.setNext({ ok: true, otpId: 'otp-allow-happy' });
    built.owner.setNext({ owner: true, studentId: 9001 });
    const out = await built.service.decide(
      { ...baseInput(), room_id: 'room-jitsi-1', media_policy: 'allow_mic_camera' },
      META,
    );
    expect(out.decision).toBe('allow');
    expect(out.student_id).toBe(9001);
    expect(out.denial).toBeNull();
    expect(out.room_id).toBe('room-jitsi-1');
    expect(out.media_policy).toBe('allow_mic_camera');
  });

  it('7b) allow path omits room_id / media_policy when the request did not supply them', async () => {
    built.otp.setNext({ ok: true, otpId: 'otp-allow-clean' });
    built.owner.setNext({ owner: true, studentId: 7 });
    const out = await built.service.decide(baseInput(), META);
    expect(out.decision).toBe('allow');
    expect(out.student_id).toBe(7);
    expect(out.denial).toBeNull();
    expect(out.room_id).toBeUndefined();
    expect(out.media_policy).toBeUndefined();
  });

  it('OTP verify is invoked with subject=String(canvas_user_id) and scope=access.decision', async () => {
    built.otp.setNext({ ok: true, otpId: 'otp-scope-subject' });
    built.owner.setNext({ owner: false, studentId: null });
    await built.service.decide(
      { device_id: 'SN-SCOPE-1', otp_proof: '000000', canvas_user_id: 4242 },
      META,
    );
    expect(built.otp.calls).toEqual([
      { subject: '4242', scope: ACCESS_DECISION_OTP_SCOPE, code: '000000' },
    ]);
    // Lock the scope constant at the call site too so a refactor
    // that flips the wire scope to e.g. 'access_decision' is caught
    // here (the integration suite verifies the same against the
    // real OtpClient).
    expect(built.otp.calls[0]?.scope).toBe('access.decision');
  });

  it('owner check receives (serial, canvas_user_id) verbatim — no predicate distinction leaks', async () => {
    built.otp.setNext({ ok: true, otpId: 'otp-owner-probe' });
    built.owner.setNext({ owner: false, studentId: null });
    await built.service.decide(
      { device_id: 'SN-PROBE-9', otp_proof: '111111', canvas_user_id: 9 },
      META,
    );
    expect(built.owner.calls).toEqual([{ serialNumber: 'SN-PROBE-9', canvasUserId: 9 }]);
  });

  it('serial-leak guard: no deny code path returns the serial in the response', async () => {
    const cases: Array<{
      label: string;
      otpProgram:
        | { ok: true; otpId: string }
        | { ok: false; reason: 'invalid' | 'locked' | 'unknown' }
        | { throw: true; error: unknown };
      ownerProgram?: { owner: boolean; studentId: number | null };
      input?: DecisionRequest;
    }> = [
      // otp_missing — empty otp_proof short-circuits before any
      // dependency call, so we override the input and leave OTP
      // unprogrammed (the service never asks for it).
      {
        label: 'otp_missing',
        otpProgram: { ok: true, otpId: 'x' },
        input: { ...baseInput(), otp_proof: '' } as DecisionRequest,
      },
      { label: 'otp_invalid', otpProgram: { ok: false, reason: 'invalid' } },
      { label: 'lockout', otpProgram: { ok: false, reason: 'locked' } },
      { label: 'dep_fail_unknown', otpProgram: { ok: false, reason: 'unknown' } },
      {
        label: 'dep_fail_throw',
        otpProgram: { throw: true, error: AppError.serviceUnavailable('otp_service_5xx') },
      },
      {
        label: 'device_unknown',
        otpProgram: { ok: true, otpId: 'x' },
        ownerProgram: { owner: false, studentId: null },
      },
    ];
    for (const c of cases) {
      const built2 = buildService();
      built2.otp.setNext(c.otpProgram);
      if (c.ownerProgram) built2.owner.setNext(c.ownerProgram);
      const out = await built2.service.decide(c.input ?? baseInput(), META);
      expect(out.decision).toBe('deny');
      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain('SN-UNIT-1');
    }
  });
});

describe('AccessDecisionService.decide — return shape mirrors DecisionResponse (unit)', () => {
  it('deny.otp_invalid envelope: { decision, denial, student_id, no allow-passthroughs }', async () => {
    const built = buildService();
    built.otp.setNext({ ok: false, reason: 'invalid' });
    const out = await built.service.decide(baseInput(), META);
    expect(out).toEqual({
      decision: 'deny',
      student_id: null,
      denial: 'deny.otp_invalid',
    });
    // No `room_id` / `media_policy` field at all when the request
    // did not supply them; the response shape must not silently
    // carry undefined-key noise that downstream consumers might
    // mistype as a real value.
    expect('room_id' in out).toBe(false);
    expect('media_policy' in out).toBe(false);
  });
});