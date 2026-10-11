/**
 * Focused unit tests for the MFA shared Zod DTOs in
 * `packages/shared/src/dto/mfa.ts`.
 *
 * The DTOs are the wire contract shared between apps/api
 * (the route layer) and apps/web (the MFA page). Each test
 * pins the shape so a refactor that loosens or tightens a
 * field trips a clear failure here.
 *
 * The `matricula` field is the focus of these tests: it is
 * the SIS matrícula exposed on BOTH `MfaAuthenticateResponse`
 * and `MfaConsumeResponse` so a downstream Jitsi proxy can
 * set the participant display name to the matrícula without
 * a follow-up SIS lookup. The field is nullable so legacy
 * rows (inserted before migration 0020) and synthetic
 * high-privacy students (sis_id + canvas_user_id only) can
 * surface as `null` without coercion.
 *
 * Mirrors the convention in `apps/api/test/unit/access-decision-schema.test.ts`
 * — shared DTOs are exercised from the apps/api test suite
 * because `apps/api/jest.config.cjs` resolves
 * `@quorum-backoffice/shared` to the source tree.
 */
import {
  MfaAuthenticateRequest,
  MfaAuthenticateResponse,
  MfaSessionResponse,
  MfaConsumeResponse,
  MFA_AUTHENTICATE_OTP_SCOPE,
  MFA_SESSION_COOKIE_NAME,
} from '@quorum-backoffice/shared';

describe('MfaAuthenticateResponse.matricula — SIS identity surface (authenticate path)', () => {
  const base = {
    canvas_user_id: 7001,
    student_name: 'Marie Curie',
    student_email: 'marie@example.test',
    matricula: 'A00001',
    role: 'student' as const,
    session_id: 'sid-token-123456789012345678',
    expires_at: '2026-01-01T00:00:00.000Z',
  };

  it('accepts a fully-populated response with a non-null matrícula', () => {
    const r = MfaAuthenticateResponse.safeParse(base);
    expect(r.success).toBe(true);
  });

  it('accepts a `null` matrícula (legacy row / synthetic high-privacy student)', () => {
    const r = MfaAuthenticateResponse.safeParse({ ...base, matricula: null });
    expect(r.success).toBe(true);
  });

  it('rejects a missing `matricula` field (the shape is required, nullable but not optional)', () => {
    // The DTO declares `matricula: z.string().nullable()`. That
    // pins the key as REQUIRED with `string | null` as the
    // value type — a JSON payload that omits the key entirely
    // must fail to parse so a Jitsi proxy that branches on the
    // presence of the key cannot see it disappear silently.
    const r = MfaAuthenticateResponse.safeParse({
      canvas_user_id: base.canvas_user_id,
      student_name: base.student_name,
      student_email: base.student_email,
      role: base.role,
      session_id: base.session_id,
      expires_at: base.expires_at,
    });
    expect(r.success).toBe(false);
  });

  it('rejects a non-string matrícula (number)', () => {
    const r = MfaAuthenticateResponse.safeParse({
      ...base,
      // Cast through unknown to assert the runtime guard:
      // a number must NOT slip through as a valid matrícula
      // (the field is `z.string().nullable()`, so a number
      // is a parse error at runtime even though TypeScript
      // would otherwise widen the union).
      matricula: 12345 as unknown as string | null,
    });
    expect(r.success).toBe(false);
  });

  it('survives a JSON round-trip with a non-null matrícula', () => {
    const r1 = MfaAuthenticateResponse.parse(base);
    const json = JSON.parse(JSON.stringify(r1));
    const r2 = MfaAuthenticateResponse.parse(json);
    expect(r2).toEqual(r1);
    expect(r2.matricula).toBe('A00001');
  });

  it('survives a JSON round-trip with a `null` matrícula', () => {
    const r1 = MfaAuthenticateResponse.parse({ ...base, matricula: null });
    const json = JSON.parse(JSON.stringify(r1));
    const r2 = MfaAuthenticateResponse.parse(json);
    expect(r2.matricula).toBeNull();
  });
});

describe('MfaConsumeResponse.matricula — SIS identity surface (consume path)', () => {
  const base = {
    canvas_user_id: 7001,
    student_name: 'Marie Curie',
    student_email: 'marie@example.test',
    matricula: 'A00001',
    role: 'student' as const,
    next_url: 'https://canvas.example.com/dashboard',
  };

  it('accepts a fully-populated response with a non-null matrícula', () => {
    const r = MfaConsumeResponse.safeParse(base);
    expect(r.success).toBe(true);
  });

  it('accepts a `null` matrícula (legacy row / synthetic high-privacy student)', () => {
    const r = MfaConsumeResponse.safeParse({ ...base, matricula: null });
    expect(r.success).toBe(true);
  });

  it('rejects a missing `matricula` field (the shape is required, nullable but not optional)', () => {
    const r = MfaConsumeResponse.safeParse({
      canvas_user_id: base.canvas_user_id,
      student_name: base.student_name,
      student_email: base.student_email,
      role: base.role,
      next_url: base.next_url,
    });
    expect(r.success).toBe(false);
  });

  it('rejects a non-string matrícula (number)', () => {
    const r = MfaConsumeResponse.safeParse({
      ...base,
      matricula: 12345 as unknown as string | null,
    });
    expect(r.success).toBe(false);
  });

  it('survives a JSON round-trip with a non-null matrícula', () => {
    const r1 = MfaConsumeResponse.parse(base);
    const json = JSON.parse(JSON.stringify(r1));
    const r2 = MfaConsumeResponse.parse(json);
    expect(r2).toEqual(r1);
    expect(r2.matricula).toBe('A00001');
  });

  it('survives a JSON round-trip with a `null` matrícula', () => {
    const r1 = MfaConsumeResponse.parse({ ...base, matricula: null });
    const json = JSON.parse(JSON.stringify(r1));
    const r2 = MfaConsumeResponse.parse(json);
    expect(r2.matricula).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sanity checks for the other MFA DTOs / constants — the focused
// matricula tests above are the purpose of this file, but the suite
// also pins the rest of the MFA wire surface so a refactor that
// silently changes another field trips here.
// ---------------------------------------------------------------------------

describe('MfaAuthenticateRequest (regression — unchanged shape)', () => {
  it('accepts a minimal valid request', () => {
    const r = MfaAuthenticateRequest.safeParse({
      marbete_code: 'CODE-12345678',
      serial_number: 'SN-123456',
      otp: 'AB12CD',
    });
    expect(r.success).toBe(true);
  });
});

describe('MfaSessionResponse (regression — unchanged shape)', () => {
  it('accepts a logged-in student response', () => {
    const r = MfaSessionResponse.safeParse({
      canvas_user_id: 7001,
      student_name: 'Marie Curie',
      student_email: 'marie@example.test',
      session_id: 'sid-token-123456789012345678',
      expires_at: '2026-01-01T00:00:00.000Z',
    });
    expect(r.success).toBe(true);
  });
});

describe('MFA constants (regression — unchanged shape)', () => {
  it('MFA_AUTHENTICATE_OTP_SCOPE pins the documented literal', () => {
    expect(MFA_AUTHENTICATE_OTP_SCOPE).toBe('mfa.access');
  });

  it('MFA_SESSION_COOKIE_NAME pins the documented `__Host-` prefix', () => {
    expect(MFA_SESSION_COOKIE_NAME).toBe('__Host-mfa_sid');
    expect(MFA_SESSION_COOKIE_NAME.startsWith('__Host-')).toBe(true);
  });
});
