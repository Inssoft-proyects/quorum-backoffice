/**
 * B3.1 unit tests — access-decision DTOs (shared Zod schemas).
 *
 * The Canvas/Jitsi federated access feature exposes a single
 * `POST /v1/access/decision` endpoint (added in B3.2) that takes a
 * `DecisionRequest` and returns a `DecisionResponse`. The wire
 * shape is the single source of truth for the access-decision
 * contract and lives in `packages/shared/src/dto/access-decision.ts`
 * so apps/api and apps/web can both consume it.
 *
 * What we lock down here:
 *   - DenialCode enum has EXACTLY the nine doc-taxonomy values
 *     (mirror `deny.*` in design.md §6). Adding a new value is a
 *     breaking change and must be a deliberate migration.
 *   - DecisionRequest requires `device_id` (string serial) and
 *     `otp_proof` (string code). Everything else is optional.
 *   - DecisionResponse requires `decision` ('allow' | 'deny'),
 *     `student_id` (number | null), and `denial` (DenialCode | null);
 *     it mirrors back the optional `room_id` / `media_policy`
 *     passthrough fields when present.
 *   - Round-trip: a valid object parses; an invalid object is rejected
 *     with a Zod error.
 */
import {
  DecisionRequest,
  DecisionResponse,
  DenialCode,
  AccessDecision,
  ACCESS_DECISION_OTP_SCOPE,
} from '@quorum-backoffice/shared';

describe('DenialCode (shared Zod enum) — deny.* taxonomy', () => {
  const EXPECTED = [
    'deny.marbete_unknown',
    'deny.device_unknown',
    'deny.otp_missing',
    'deny.otp_invalid',
    'deny.lockout',
    'deny.enrollment_missing',
    'deny.media_denied',
    'deny.idp_untrusted',
    'deny.dependency_fail',
  ] as const;

  it('contains exactly the nine doc-taxonomy values (no more, no less)', () => {
    expect(DenialCode.options).toEqual([...EXPECTED]);
  });

  it.each(EXPECTED)('accepts `%s`', (value) => {
    const r = DenialCode.safeParse(value);
    expect(r.success).toBe(true);
  });

  it('rejects an unknown denial label', () => {
    const r = DenialCode.safeParse('deny.not_a_real_code');
    expect(r.success).toBe(false);
  });

  it('rejects an empty string', () => {
    const r = DenialCode.safeParse('');
    expect(r.success).toBe(false);
  });
});

describe('DecisionRequest (shared Zod schema)', () => {
  it('accepts the minimal valid request (only the required fields)', () => {
    const r = DecisionRequest.safeParse({
      device_id: 'dev-abc-1234',
      otp_proof: 'AB12CD',
      canvas_user_id: 42,
    });
    expect(r.success).toBe(true);
  });

  it('accepts a fully-populated request (idp_subject, marbete_id, room_id, media_policy, canvas_user_id)', () => {
    const r = DecisionRequest.safeParse({
      idp_subject: 'canvas:42',
      marbete_id: 'M-7Q3X9K',
      device_id: 'dev-abc-1234',
      otp_proof: 'AB12CD',
      room_id: 'room-jitsi-1',
      media_policy: 'allow_mic_camera',
      canvas_user_id: 42,
    });
    expect(r.success).toBe(true);
  });

  it('rejects a request with no device_id', () => {
    const r = DecisionRequest.safeParse({ otp_proof: 'AB12CD', canvas_user_id: 42 });
    expect(r.success).toBe(false);
  });

  it('rejects a request with no otp_proof', () => {
    const r = DecisionRequest.safeParse({ device_id: 'dev-abc-1234', canvas_user_id: 42 });
    expect(r.success).toBe(false);
  });

  it('rejects a request with non-string device_id (e.g. a number)', () => {
    const r = DecisionRequest.safeParse({
      device_id: 42,
      otp_proof: 'AB12CD',
      canvas_user_id: 42,
    });
    expect(r.success).toBe(false);
  });

  it('rejects a request with empty-string device_id', () => {
    const r = DecisionRequest.safeParse({
      device_id: '',
      otp_proof: 'AB12CD',
      canvas_user_id: 42,
    });
    expect(r.success).toBe(false);
  });

  it('rejects a request with no canvas_user_id (the interim identity is REQUIRED for B3.2)', () => {
    const r = DecisionRequest.safeParse({
      device_id: 'dev-abc-1234',
      otp_proof: 'AB12CD',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a request with non-integer canvas_user_id (e.g. a string)', () => {
    const r = DecisionRequest.safeParse({
      device_id: 'dev-abc-1234',
      otp_proof: 'AB12CD',
      canvas_user_id: '42',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a request with non-positive canvas_user_id', () => {
    const r1 = DecisionRequest.safeParse({
      device_id: 'dev-abc-1234',
      otp_proof: 'AB12CD',
      canvas_user_id: 0,
    });
    expect(r1.success).toBe(false);
    const r2 = DecisionRequest.safeParse({
      device_id: 'dev-abc-1234',
      otp_proof: 'AB12CD',
      canvas_user_id: -7,
    });
    expect(r2.success).toBe(false);
  });

  it('accepts an empty-string otp_proof at the wire boundary (mapped to deny.otp_missing by the service)', () => {
    const r = DecisionRequest.safeParse({
      device_id: 'dev-abc-1234',
      otp_proof: '',
      canvas_user_id: 42,
    });
    expect(r.success).toBe(true);
  });

it('treats idp_subject as optional and reserved (mapping deferred to IdP)', () => {
    const r1 = DecisionRequest.safeParse({
      device_id: 'dev-abc-1234',
      otp_proof: 'AB12CD',
      canvas_user_id: 42,
      idp_subject: 'canvas:42',
    });
    expect(r1.success).toBe(true);
    const r2 = DecisionRequest.safeParse({
      device_id: 'dev-abc-1234',
      otp_proof: 'AB12CD',
      canvas_user_id: 42,
    });
    expect(r2.success).toBe(true);
  });

  it('treats room_id and media_policy as optional strings', () => {
    const r1 = DecisionRequest.safeParse({
      device_id: 'dev-abc-1234',
      otp_proof: 'AB12CD',
      canvas_user_id: 42,
      room_id: 'room-x',
    });
    expect(r1.success).toBe(true);
    const r2 = DecisionRequest.safeParse({
      device_id: 'dev-abc-1234',
      otp_proof: 'AB12CD',
      canvas_user_id: 42,
      media_policy: 'allow_mic_only',
    });
    expect(r2.success).toBe(true);
  });
});

describe('DecisionResponse (shared Zod schema)', () => {
  it('accepts an `allow` response (denial null, student_id present)', () => {
    const r = DecisionResponse.safeParse({
      decision: 'allow',
      student_id: 42,
      denial: null,
    });
    expect(r.success).toBe(true);
  });

  it('accepts a `deny` response (student_id null, denial set)', () => {
    const r = DecisionResponse.safeParse({
      decision: 'deny',
      student_id: null,
      denial: 'deny.otp_invalid',
    });
    expect(r.success).toBe(true);
  });

  it('accepts passthrough room_id / media_policy when present', () => {
    const r = DecisionResponse.safeParse({
      decision: 'allow',
      student_id: 7,
      denial: null,
      room_id: 'room-jitsi-1',
      media_policy: 'allow_mic_camera',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a decision that is not `allow` or `deny`', () => {
    const r = DecisionResponse.safeParse({
      decision: 'maybe',
      student_id: 1,
      denial: null,
    });
    expect(r.success).toBe(false);
  });

  it('rejects a missing decision field', () => {
    const r = DecisionResponse.safeParse({ student_id: 1, denial: null });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown denial label on the response', () => {
    const r = DecisionResponse.safeParse({
      decision: 'deny',
      student_id: null,
      denial: 'deny.bogus',
    });
    expect(r.success).toBe(false);
  });

  it('round-trips a deny response through parse → JSON → parse', () => {
    const original = {
      decision: 'deny' as const,
      student_id: null,
      denial: 'deny.lockout' as const,
      room_id: 'room-x',
    };
    const parsed = DecisionResponse.parse(original);
    const json = JSON.parse(JSON.stringify(parsed));
    const reparsed = DecisionResponse.parse(json);
    expect(reparsed).toEqual(parsed);
  });
});

describe('AccessDecision (shared literal type)', () => {
  it('is the union `allow | deny`', () => {
    // The type assertion is the test: both literals are assignable
    // and the unknown literal is not.
    const allow: AccessDecision = 'allow';
    const deny: AccessDecision = 'deny';
    expect(allow).toBe('allow');
    expect(deny).toBe('deny');
  });
});

describe('ACCESS_DECISION_OTP_SCOPE (shared constant)', () => {
  it('is the literal `access.decision` — the scope the access-decision endpoint verifies against', () => {
    expect(ACCESS_DECISION_OTP_SCOPE).toBe('access.decision');
  });

  it('is a non-empty string consumable as an OtpClient scope argument', () => {
    expect(typeof ACCESS_DECISION_OTP_SCOPE).toBe('string');
    expect(ACCESS_DECISION_OTP_SCOPE.length).toBeGreaterThan(0);
    // OtpClient scopes are bounded to 64 chars; the constant must
    // fit inside that envelope to be a valid scope argument.
    expect(ACCESS_DECISION_OTP_SCOPE.length).toBeLessThanOrEqual(64);
  });
});
