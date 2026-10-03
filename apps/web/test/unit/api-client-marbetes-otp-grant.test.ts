/**
 * Tests for the 20-minute OTP grant window surface in the web
 * api-client.
 *
 * Covers:
 *  - getMarbeteOtpGrant: GETs /api/v1/marbetes/otp-grant and returns
 *    the typed response.
 *  - createMarbete / updateMarbete / deleteMarbete with an active
 *    grant: the x-otp-code header is OMITTED (the server consults
 *    the grant cache for grant-eligible actions).
 *  - createMarbete / updateMarbete / deleteMarbete without a grant:
 *    the x-otp-code header IS sent (today's behaviour).
 */
import {
  createMarbete,
  deleteMarbete,
  getMarbeteOtpGrant,
  updateMarbete,
} from '@/lib/api-client';

interface CapturedRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
  url: string;
}

function installFetchMock(
  status: number,
  responseBody: unknown,
): { read(): CapturedRequest } {
  const holder: { current: CapturedRequest | null } = { current: null };
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    holder.current = {
      method: init?.method ?? '',
      headers,
      body: String(init?.body ?? ''),
      url: typeof input === 'string' ? input : input.toString(),
    };
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return {
    read(): CapturedRequest {
      if (!holder.current) throw new Error('fetch was not called');
      return holder.current;
    },
  };
}

const detailResponseBody = {
  id: 1,
  publicUid: 'm-X',
  maskedCode: '1***X',
  status: 'active',
  assignedStudentId: null,
  assignedAt: null,
  createdAt: '',
  createdBy: 'x',
  deletedAt: null,
  deletionReason: null,
  student: null,
};

describe('getMarbeteOtpGrant', () => {
  it('GETs /api/v1/marbetes/otp-grant and returns the response shape', async () => {
    const capture = installFetchMock(200, {
      active: true,
      expiresAt: '2025-01-01T12:20:00Z',
    });
    const status = await getMarbeteOtpGrant();
    const captured = capture.read();
    expect(captured.method).toBe('GET');
    expect(captured.url).toMatch(/api\/v1\/marbetes\/otp-grant$/);
    expect(status).toEqual({ active: true, expiresAt: '2025-01-01T12:20:00Z' });
  });

  it('returns the no-grant shape when the server says so', async () => {
    installFetchMock(200, { active: false, expiresAt: null });
    await expect(getMarbeteOtpGrant()).resolves.toEqual({
      active: false,
      expiresAt: null,
    });
  });
});

describe('destructive marbete wrappers — OTP header omitted when grant is active', () => {
  it('createMarbete with otpCode=undefined sends NO x-otp-code header', async () => {
    const capture = installFetchMock(201, detailResponseBody);
    await createMarbete({ code: 'WITH-GRANT-1' }, undefined);
    const req = capture.read();
    expect(req.method).toBe('POST');
    expect(req.headers['x-otp-code']).toBeUndefined();
    expect(req.url).toMatch(/api\/v1\/marbetes$/);
  });

  it('updateMarbete with otpCode=undefined sends NO x-otp-code header', async () => {
    const capture = installFetchMock(200, detailResponseBody);
    await updateMarbete(1, { canvasUserId: null }, undefined);
    const req = capture.read();
    expect(req.method).toBe('PATCH');
    expect(req.headers['x-otp-code']).toBeUndefined();
    expect(req.url).toMatch(/api\/v1\/marbetes\/1$/);
  });

  it('deleteMarbete with otpCode=undefined sends NO x-otp-code header', async () => {
    const capture = installFetchMock(200, detailResponseBody);
    await deleteMarbete(1, { reason: 'lost in transit' }, undefined);
    const req = capture.read();
    expect(req.method).toBe('DELETE');
    expect(req.headers['x-otp-code']).toBeUndefined();
    expect(req.url).toMatch(/api\/v1\/marbetes\/1$/);
  });
});

describe('destructive marbete wrappers — OTP header IS sent without a grant', () => {
  it('createMarbete with otpCode="..." sends x-otp-code', async () => {
    const capture = installFetchMock(201, detailResponseBody);
    await createMarbete({ code: 'NO-GRANT-1' }, '123456');
    expect(capture.read().headers['x-otp-code']).toBe('123456');
  });

  it('updateMarbete with otpCode="..." sends x-otp-code', async () => {
    const capture = installFetchMock(200, detailResponseBody);
    await updateMarbete(1, { canvasUserId: null }, '123456');
    expect(capture.read().headers['x-otp-code']).toBe('123456');
  });

  it('deleteMarbete with otpCode="..." sends x-otp-code', async () => {
    const capture = installFetchMock(200, detailResponseBody);
    await deleteMarbete(1, { reason: 'lost in transit' }, '123456');
    expect(capture.read().headers['x-otp-code']).toBe('123456');
  });
});