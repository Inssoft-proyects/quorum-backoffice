/**
 * Unit tests for the HMAC `OtpClient` (HMAC-SHA256 wire signature,
 * `Authorization: HMAC <service-name> <timestamp> <hex>` header,
 * `token` body field for verify).
 *
 * What we assert:
 *  - HMAC signature bytes exactly equal what we expect for a known
 *    secret + body + timestamp.
 *  - The `Authorization` header is `HMAC quorum-backoffice <ts> <hex>`
 *    (default service name).
 *  - The verify body is `{ subject, scope, token }` (NOT `code`).
 *  - Provider 200 with `valid: true` → domain-level `{ ok: true, otpId }`.
 *  - Provider 200 with `valid !== true` → service_unavailable (we do not
 *    blindly trust a 200 envelope).
 *  - Provider 409 → `ok: false, reason: 'invalid'` (THE user-OTP path).
 *  - Provider 423 → same as 409 (invalid user OTP).
 *  - Provider 429 → `ok: false, reason: 'locked'`.
 *  - Provider 401/403 → throws service_unavailable (HMAC identity
 *    misconfiguration, NOT a user-OTP problem).
 *  - Provider 5xx → throws service_unavailable.
 *  - Custom service name override propagates to the header.
 */
import { OtpClient } from '../../src/services/otp-client';
import { AppError } from '../../src/lib/errors';

const SECRET = 'test-otp-hmac-secret-1234567890abcdef';
const SERVICE_NAME = 'quorum-backoffice';
const URL = 'http://127.0.0.1:65535';

interface CapturedCall {
  url: string;
  method: string;
  authorization: string | null;
  body: string;
  contentType: string | null;
}

function makeCapturingFetch(
  handler: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      authorization: headers?.['authorization'] ?? null,
      body: typeof init?.body === 'string' ? init.body : '',
      contentType: headers?.['content-type'] ?? null,
    });
    return await handler(input, init);
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe('OtpClient (HMAC) — wire signature', () => {
  it('sends Authorization: HMAC <service-name> <timestamp> <hex-signature>', async () => {
    const captured = makeCapturingFetch(async () =>
      new Response(JSON.stringify({ valid: true, otp_id: 'otp-1' }), { status: 200 }),
    );
    const fixedTs = Date.UTC(2025, 0, 1, 0, 0, 0); // 1735689600000
    const client = new OtpClient({
      baseUrl: URL,
      serviceToken: SECRET,
      fetchImpl: captured.fetch,
      now: () => fixedTs,
    });
    const r = await client.verify({ subject: 'admin', scope: 'login', code: 'AB12CD' });
    expect(r.ok).toBe(true);
    expect(captured.calls).toHaveLength(1);
    const call = captured.calls[0]!;
    expect(call.url).toBe(`${URL}/v1/otps/verify`);
    expect(call.method).toBe('POST');
    expect(call.contentType).toBe('application/json');
    // Header structure: `HMAC <service-name> <timestamp> <hex>`
    expect(call.authorization).toMatch(/^HMAC /);
    const parts = call.authorization!.split(/\s+/);
    expect(parts[1]).toBe(SERVICE_NAME);
    expect(parts[2]).toBe('1735689600');
    expect(parts[3]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs the exact raw body bytes (HMAC-SHA256(secret, `${ts}.${body}`))', async () => {
    const captured = makeCapturingFetch(async () =>
      new Response(JSON.stringify({ valid: true }), { status: 200 }),
    );
    const fixedTs = Date.UTC(2025, 0, 1, 0, 0, 0);
    const client = new OtpClient({
      baseUrl: URL,
      serviceToken: SECRET,
      fetchImpl: captured.fetch,
      now: () => fixedTs,
    });
    await client.verify({ subject: 'admin', scope: 'login', code: 'AB12CD' });
    const call = captured.calls[0]!;
    const rawBody = call.body;
    const expected = await OtpClient.computeSignature({
      secret: SECRET,
      timestamp: '1735689600',
      rawBody,
    });
    const parts = call.authorization!.split(/\s+/);
    expect(parts[3]).toBe(expected);
  });

  it('uses the default service name `quorum-backoffice`', async () => {
    const captured = makeCapturingFetch(async () =>
      new Response(JSON.stringify({ valid: true }), { status: 200 }),
    );
    const client = new OtpClient({
      baseUrl: URL,
      serviceToken: SECRET,
      fetchImpl: captured.fetch,
    });
    await client.verify({ subject: 'admin', scope: 'login', code: 'AB12CD' });
    const parts = captured.calls[0]!.authorization!.split(/\s+/);
    expect(parts[1]).toBe('quorum-backoffice');
  });

  it('uses an explicit service name override in the header', async () => {
    const captured = makeCapturingFetch(async () =>
      new Response(JSON.stringify({ valid: true }), { status: 200 }),
    );
    const client = new OtpClient({
      baseUrl: URL,
      serviceToken: SECRET,
      serviceName: 'quorum-backoffice-canary',
      fetchImpl: captured.fetch,
    });
    await client.verify({ subject: 'admin', scope: 'login', code: 'AB12CD' });
    const parts = captured.calls[0]!.authorization!.split(/\s+/);
    expect(parts[1]).toBe('quorum-backoffice-canary');
  });
});

describe('OtpClient (HMAC) — request body field', () => {
  it('verify sends `token`, not `code`, in the JSON body', async () => {
    const captured = makeCapturingFetch(async () =>
      new Response(JSON.stringify({ valid: true, otp_id: 'otp-1' }), { status: 200 }),
    );
    const client = new OtpClient({
      baseUrl: URL,
      serviceToken: SECRET,
      fetchImpl: captured.fetch,
    });
    await client.verify({ subject: 'admin', scope: 'login', code: 'AB12CD' });
    const call = captured.calls[0]!;
    const parsed = JSON.parse(call.body) as Record<string, unknown>;
    expect(parsed).toEqual({ subject: 'admin', scope: 'login', token: 'AB12CD' });
    expect('code' in parsed).toBe(false);
  });

  it('verify body exactly equals the bytes used in the HMAC signature', async () => {
    const captured = makeCapturingFetch(async () =>
      new Response(JSON.stringify({ valid: true }), { status: 200 }),
    );
    const fixedTs = Date.UTC(2025, 0, 1, 0, 0, 0);
    const client = new OtpClient({
      baseUrl: URL,
      serviceToken: SECRET,
      fetchImpl: captured.fetch,
      now: () => fixedTs,
    });
    await client.verify({ subject: 'admin', scope: 'login', code: 'ZZ99AA' });
    const call = captured.calls[0]!;
    const expected = await OtpClient.computeSignature({
      secret: SECRET,
      timestamp: '1735689600',
      rawBody: call.body,
    });
    expect(call.authorization!.split(/\s+/)[3]).toBe(expected);
    expect(call.body).toBe(JSON.stringify({ subject: 'admin', scope: 'login', token: 'ZZ99AA' }));
  });

  it('trims whitespace from subject/scope/token before sending', async () => {
    const captured = makeCapturingFetch(async () =>
      new Response(JSON.stringify({ valid: true }), { status: 200 }),
    );
    const client = new OtpClient({
      baseUrl: URL,
      serviceToken: SECRET,
      fetchImpl: captured.fetch,
    });
    await client.verify({ subject: ' admin ', scope: ' login ', code: ' AB12CD ' });
    const call = captured.calls[0]!;
    expect(JSON.parse(call.body)).toEqual({ subject: 'admin', scope: 'login', token: 'AB12CD' });
  });
});

describe('OtpClient (HMAC) — provider outcome mapping', () => {
  it('200 with valid=true → domain-level { ok: true, otpId }', async () => {
    const captured = makeCapturingFetch(async () =>
      new Response(JSON.stringify({ valid: true, otp_id: 'OTP-7', consumed_at: '2025-01-01T00:00:00Z' }), {
        status: 200,
      }),
    );
    const client = new OtpClient({
      baseUrl: URL,
      serviceToken: SECRET,
      fetchImpl: captured.fetch,
    });
    const r = await client.verify({ subject: 'admin', scope: 'login', code: 'AB12CD' });
    expect(r).toEqual({ ok: true, otpId: 'OTP-7' });
  });

  it('200 with valid != true → throws service_unavailable (envelope mismatch)', async () => {
    const captured = makeCapturingFetch(async () =>
      new Response(JSON.stringify({ valid: false }), { status: 200 }),
    );
    const client = new OtpClient({
      baseUrl: URL,
      serviceToken: SECRET,
      fetchImpl: captured.fetch,
    });
    await expect(
      client.verify({ subject: 'admin', scope: 'login', code: 'AB12CD' }),
    ).rejects.toMatchObject({
      code: 'service_unavailable',
    });
  });

  it('409 → ok:false reason:invalid (THE user-OTP path)', async () => {
    const captured = makeCapturingFetch(async () =>
      new Response(JSON.stringify({ error: { code: 'verify_rejected' } }), { status: 409 }),
    );
    const client = new OtpClient({
      baseUrl: URL,
      serviceToken: SECRET,
      fetchImpl: captured.fetch,
    });
    const r = await client.verify({ subject: 'admin', scope: 'login', code: 'AB12CD' });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });

  it('423 → ok:false reason:invalid (also invalid user OTP)', async () => {
    const captured = makeCapturingFetch(async () =>
      new Response('locked', { status: 423 }),
    );
    const client = new OtpClient({
      baseUrl: URL,
      serviceToken: SECRET,
      fetchImpl: captured.fetch,
    });
    const r = await client.verify({ subject: 'admin', scope: 'login', code: 'AB12CD' });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });

  it('429 → ok:false reason:locked', async () => {
    const captured = makeCapturingFetch(async () =>
      new Response(JSON.stringify({ error: { code: 'rate_limited' } }), { status: 429 }),
    );
    const client = new OtpClient({
      baseUrl: URL,
      serviceToken: SECRET,
      fetchImpl: captured.fetch,
    });
    const r = await client.verify({ subject: 'admin', scope: 'login', code: 'AB12CD' });
    expect(r).toEqual({ ok: false, reason: 'locked' });
  });

  it('401 → throws service_unavailable (NOT a user-OTP error)', async () => {
    const captured = makeCapturingFetch(async () =>
      new Response('unauthorized', { status: 401 }),
    );
    const client = new OtpClient({
      baseUrl: URL,
      serviceToken: SECRET,
      fetchImpl: captured.fetch,
    });
    const caught = await client
      .verify({ subject: 'admin', scope: 'login', code: 'AB12CD' })
      .catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(AppError);
    const appErr = caught as AppError;
    expect(appErr.code).toBe('service_unavailable');
    expect(appErr.httpStatus).toBe(503);
  });

  it('403 → throws service_unavailable (HMAC identity misconfiguration)', async () => {
    const captured = makeCapturingFetch(async () =>
      new Response('forbidden', { status: 403 }),
    );
    const client = new OtpClient({
      baseUrl: URL,
      serviceToken: SECRET,
      fetchImpl: captured.fetch,
    });
    try {
      await client.verify({ subject: 'admin', scope: 'login', code: 'AB12CD' });
      fail('should have thrown');
    } catch (err) {
      const appErr = err as AppError;
      expect(appErr.code).toBe('service_unavailable');
      expect(appErr.httpStatus).toBe(503);
    }
  });

  it('500 → throws service_unavailable', async () => {
    const captured = makeCapturingFetch(async () =>
      new Response('boom', { status: 500 }),
    );
    const client = new OtpClient({
      baseUrl: URL,
      serviceToken: SECRET,
      fetchImpl: captured.fetch,
    });
    try {
      await client.verify({ subject: 'admin', scope: 'login', code: 'AB12CD' });
      fail('should have thrown');
    } catch (err) {
      const appErr = err as AppError;
      expect(appErr.code).toBe('service_unavailable');
    }
  });

  it('400 → ok:false reason:invalid (provider rejected the call shape)', async () => {
    const captured = makeCapturingFetch(async () =>
      new Response('bad request', { status: 400 }),
    );
    const client = new OtpClient({
      baseUrl: URL,
      serviceToken: SECRET,
      fetchImpl: captured.fetch,
    });
    const r = await client.verify({ subject: 'admin', scope: 'login', code: 'AB12CD' });
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('OtpClient (HMAC) — shape guards', () => {
  it('throws bad_request when subject is empty', async () => {
    const captured = makeCapturingFetch(async () => new Response('', { status: 200 }));
    const client = new OtpClient({
      baseUrl: URL,
      serviceToken: SECRET,
      fetchImpl: captured.fetch,
    });
    try {
      await client.verify({ subject: '', scope: 'login', code: 'AB12CD' });
      fail('should have thrown');
    } catch (err) {
      const appErr = err as AppError;
      expect(appErr.code).toBe('bad_request');
      expect(appErr.httpStatus).toBe(400);
    }
  });
});
